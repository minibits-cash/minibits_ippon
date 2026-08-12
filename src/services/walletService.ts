import {
    Wallet,
    Amount,
    AmountLike,
    MintQuoteBolt11Response,
    MeltQuoteBolt11Response,
    MeltProofsResponse,
    Proof,
    ProofLike,
    Token,
    ProofState,
    MeltQuoteState,
    CheckStateEnum,
    MintOperationError,
    OutputConfig,
    getDecodedToken,
    getTokenMetadata,
} from '@cashu/cashu-ts'
import { ProofStatus } from '@prisma/client'
import prisma from '../utils/prismaClient'
import AppError, { Err } from '../utils/AppError'
import { log } from './logService'

type CachedWallet = {
    wallet: Wallet
    keysetsLoadedAt: number
}

const _wallets = new Map<string, CachedWallet>()

// Keysets are re-fetched at least this often. NUT-02 v2 keysets carry a final_expiry and mints
// rotate them, so a long-lived process must not pin the keyset it saw at startup.
const KEYSET_TTL_MS = Number(process.env.KEYSET_TTL_MS || 10 * 60 * 1000)

const getMintUrls = function (): string[] {
    const raw = process.env.MINT_URLS || ''
    return raw.split(',').map(u => u.trim()).filter(u => u.length > 0)
}


const toNumber = function (amount: AmountLike): number {
    return Amount.from(amount).toNumber()
}


/**
 * True when the wallet's bound keyset can still be used to create new outputs. A keyset that the
 * mint deactivated or that passed its final_expiry (NUT-02 v2) will have its outputs rejected.
 */
const isBoundKeysetUsable = function (wallet: Wallet): boolean {
    try {
        const keyset = wallet.getKeyset()
        const expiry = keyset.expiry
        return keyset.isActive && (expiry === undefined || expiry * 1000 > Date.now())
    } catch {
        return false
    }
}


/**
 * Re-fetch keysets and keys from the mint and rebind to the cheapest active keyset. loadMint keeps
 * an existing binding, so rebinding has to be explicit once the old keyset goes inactive.
 */
const refreshKeysets = async function (cached: CachedWallet, mintUrl: string): Promise<void> {
    await cached.wallet.loadMint(true)
    cached.keysetsLoadedAt = Date.now()

    if (!isBoundKeysetUsable(cached.wallet)) {
        const cheapest = cached.wallet.keyChain.getCheapestKeyset()
        cached.wallet.bindKeyset(cheapest.id)
        log.info('[refreshKeysets] Rebound wallet to a new keyset', { mintUrl, keysetId: cheapest.id })
    }
}


const getWallet = async function (mintUrl: string): Promise<Wallet> {
    const cached = _wallets.get(mintUrl)

    if (cached) {
        const isStale = Date.now() - cached.keysetsLoadedAt > KEYSET_TTL_MS

        if (isStale || !isBoundKeysetUsable(cached.wallet)) {
            try {
                await refreshKeysets(cached, mintUrl)
            } catch (e: any) {
                // A refresh failure is not fatal while the bound keyset is still usable.
                log.warn('[getWallet] Keyset refresh failed, keeping cached keysets', { mintUrl, error: e.message })
                if (!isBoundKeysetUsable(cached.wallet)) {
                    throw new AppError(500, Err.CONNECTION_ERROR, `Mint has no usable keyset: ${e.message}`, { caller: 'getWallet' })
                }
            }
        }

        return cached.wallet
    }

    const unit = process.env.UNIT || 'sat'

    log.debug('[getWallet] Creating new cashu-ts wallet instance', { mintUrl, unit })

    const cashuWallet = new Wallet(mintUrl, { unit })
    await cashuWallet.loadMint()
    _wallets.set(mintUrl, { wallet: cashuWallet, keysetsLoadedAt: Date.now() })

    return cashuWallet
}


const getProofsAmount = function (proofs: Array<Pick<ProofLike, 'amount'>>): number {
    return Amount.sum(proofs.map(p => p.amount)).toNumber()
}


const getTokenAmount = function (tokenStr: string): number {
    // getTokenMetadata does not resolve keyset ids, so it works for any mint without a round trip.
    return getTokenMetadata(tokenStr).amount.toNumber()
}


/**
 * Decode a token, resolving NUT-02 v2 short keyset ids against the issuing mint's keysets.
 *
 * A cashuB token carries v2 keyset ids truncated, so getDecodedToken needs the mint's full keyset
 * id list to expand them. Tokens that only use v1 (`00`-prefixed) ids decode without that list,
 * which is why an unreachable mint is a warning rather than an error here.
 */
const decodeToken = async function (tokenStr: string): Promise<Token> {
    const { mint } = getTokenMetadata(tokenStr)

    let cached: CachedWallet | undefined
    let keysetIds: string[] = []

    try {
        await getWallet(mint)
        cached = _wallets.get(mint)
        keysetIds = cached?.wallet.keyChain.getAllKeysetIds() ?? []
    } catch (e: any) {
        log.warn('[decodeToken] Could not load mint keysets, decoding without them', { mint, error: e.message })
    }

    try {
        return getDecodedToken(tokenStr, keysetIds)
    } catch (e: any) {
        // The token may reference a keyset the mint added after we last loaded it.
        if (!cached) {
            throw e
        }

        log.debug('[decodeToken] Decode failed, refreshing keysets and retrying', { mint, error: e.message })
        await refreshKeysets(cached, mint)
        return getDecodedToken(tokenStr, cached.wallet.keyChain.getAllKeysetIds())
    }
}


/**
 * Make sure the wallet knows the keyset behind every proof it is about to swap.
 *
 * The mint may have rotated keysets since we last loaded them. cashu-ts rejects a swap whose
 * inputs reference a keyset missing from the keychain, and a successful decode is not proof that
 * the keyset is known: only v2 short ids are resolved against the keychain, so a token from a
 * freshly rotated v1 (`00`-prefixed) keyset decodes cleanly and then fails at the swap. Checking
 * the ids directly covers both id versions.
 */
const ensureKeysetsKnown = async function (mintUrl: string, proofs: Array<Pick<ProofLike, 'id'>>): Promise<void> {
    const cached = _wallets.get(mintUrl)
    if (!cached) {
        return
    }

    const missing = () => {
        const known = new Set(cached.wallet.keyChain.getAllKeysetIds())
        return [...new Set(proofs.map(p => p.id).filter(id => !known.has(id)))]
    }

    const unknownIds = missing()
    if (unknownIds.length === 0) {
        return
    }

    log.info('[ensureKeysetsKnown] Token references unknown keysets, refreshing from mint', { mintUrl, keysetIds: unknownIds })

    try {
        await refreshKeysets(cached, mintUrl)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, `Could not refresh keysets from mint: ${e.message}`, { caller: 'ensureKeysetsKnown' })
    }

    const stillUnknown = missing()
    if (stillUnknown.length > 0) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Token references keysets that mint ${mintUrl} does not know: ${stillUnknown.join(', ')}`, { caller: 'ensureKeysetsKnown' })
    }
}


const getWalletBalance = async function (walletId: number): Promise<{ balance: number, pendingBalance: number }> {
    const unspentResult = await prisma.proof.aggregate({
        where: { walletId, status: ProofStatus.UNSPENT },
        _sum: { amount: true },
    })

    const pendingResult = await prisma.proof.aggregate({
        where: { walletId, status: ProofStatus.PENDING },
        _sum: { amount: true },
    })

    return {
        balance: unspentResult._sum.amount || 0,
        pendingBalance: pendingResult._sum.amount || 0,
    }
}


const saveProofs = async function (walletId: number, proofs: ProofLike[], status: ProofStatus = ProofStatus.UNSPENT) {
    for (const proof of proofs) {
        await prisma.proof.create({
            data: {
                walletId,
                proofId: proof.id,
                amount: toNumber(proof.amount),
                secret: proof.secret,
                C: proof.C,
                dleq: proof.dleq ? JSON.stringify(proof.dleq) : null,
                p2pkE: proof.p2pk_e ?? null,
                witness: proof.witness ? (typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness)) : null,
                status,
            },
        })
    }
}


const loadProofs = async function (walletId: number, status?: ProofStatus): Promise<Proof[]> {
    const where: any = { walletId }
    if (status) {
        where.status = status
    } else {
        where.status = ProofStatus.UNSPENT
    }

    const dbProofs = await prisma.proof.findMany({ where })

    return dbProofs.map(p => ({
        id: p.proofId,
        amount: Amount.from(p.amount),
        secret: p.secret,
        C: p.C,
        dleq: p.dleq ? JSON.parse(p.dleq) : undefined,
        p2pk_e: p.p2pkE ?? undefined,
        witness: p.witness ?? undefined,
    }))
}


const updateProofsStatus = async function (walletId: number, secrets: string[], status: ProofStatus) {
    await prisma.proof.updateMany({
        where: {
            walletId,
            secret: { in: secrets },
        },
        data: { status },
    })
}


const createMintQuote = async function (amount: AmountLike, mintUrl: string): Promise<MintQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        const quote = await wallet.createMintQuoteBolt11(amount)
        log.debug('[createMintQuote]', { quote: quote.quote, amount: String(amount) })
        return quote
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'createMintQuote' })
    }
}


const checkMintQuote = async function (quoteId: string, mintUrl: string): Promise<MintQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.checkMintQuoteBolt11(quoteId)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'checkMintQuote' })
    }
}


const mintProofs = async function (amount: AmountLike, quoteId: string, mintUrl: string): Promise<Proof[]> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.mintProofsBolt11(amount, quoteId)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'mintProofs' })
    }
}


const sendProofs = async function (walletId: number, amount: number, mintUrl: string, p2pkPubkey?: string): Promise<{ keep: Proof[], send: Proof[] }> {
    const wallet = await getWallet(mintUrl)
    const proofs = await loadProofs(walletId)
    const totalBalance = getProofsAmount(proofs)

    if (totalBalance < amount) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Insufficient balance: ${totalBalance} < ${amount}`, { caller: 'sendProofs' })
    }

    const outputConfig: OutputConfig | undefined = p2pkPubkey
        ? { send: { type: 'p2pk', options: { pubkey: p2pkPubkey } } }
        : undefined

    // Sender pays all fees - we include fees that the receiver will need to pay when claiming the proofs,
    // to make sure he receives the full intended amount
    const { keep, send } = await wallet.send(amount, proofs, { includeFees: true }, outputConfig)

    // Determine which input proofs were consumed by the swap vs returned as-is
    const returnedSecrets = new Set([
        ...keep.map(p => p.secret),
        ...send.map(p => p.secret),
    ])
    const swappedSecrets = proofs.map(p => p.secret).filter(s => !returnedSecrets.has(s))

    // Mark only the swapped input proofs as SPENT
    if (swappedSecrets.length > 0) {
        await updateProofsStatus(walletId, swappedSecrets, ProofStatus.SPENT)
    }

    // Save only genuinely new proofs (not ones already in DB from input)
    const inputSecrets = new Set(proofs.map(p => p.secret))
    const newKeep = keep.filter(p => !inputSecrets.has(p.secret))
    const newSend = send.filter(p => !inputSecrets.has(p.secret))

    if (newKeep.length > 0) {
        await saveProofs(walletId, newKeep, ProofStatus.UNSPENT)
    }
    if (newSend.length > 0) {
        await saveProofs(walletId, newSend, ProofStatus.PENDING)
    }

    // Mark input proofs returned in send as PENDING
    const inputSendSecrets = send.map(p => p.secret).filter(s => inputSecrets.has(s))
    if (inputSendSecrets.length > 0) {
        await updateProofsStatus(walletId, inputSendSecrets, ProofStatus.PENDING)
    }

    return { keep, send }
}


const SWAP_BATCH_SIZE = 100

const receiveToken = async function (walletId: number, tokenStr: string, mintUrl: string): Promise<Proof[]> {
    // Read the mint off the token metadata first — decoding proofs needs the mint's keysets to
    // resolve NUT-02 v2 short keyset ids, and we must not fetch those from an unexpected mint.
    const { mint: tokenMint } = getTokenMetadata(tokenStr)
    if (tokenMint !== mintUrl) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Token mint '${tokenMint}' does not match wallet mint '${mintUrl}'`, { caller: 'receiveToken' })
    }

    const wallet = await getWallet(mintUrl)
    const decoded = await decodeToken(tokenStr)

    // The token may come from a keyset the mint rotated to after we last loaded it.
    await ensureKeysetsKnown(mintUrl, decoded.proofs)

    if (decoded.proofs.length <= SWAP_BATCH_SIZE) {
        // Pass the decoded token so the swap uses the already-expanded keyset ids.
        const newProofs = await wallet.receive(decoded)
        await saveProofs(walletId, newProofs, ProofStatus.UNSPENT)
        return newProofs
    }

    // Swap in batches to stay within the mint's per-swap proof limit
    const allNewProofs: Proof[] = []
    for (let i = 0; i < decoded.proofs.length; i += SWAP_BATCH_SIZE) {
        const batchToken: Token = {
            mint: decoded.mint,
            proofs: decoded.proofs.slice(i, i + SWAP_BATCH_SIZE),
            unit: decoded.unit,
        }
        const preview = await wallet.prepareSwapToReceive(batchToken)
        const { keep } = await wallet.completeSwap(preview)
        allNewProofs.push(...keep)
        // Persist per batch so a mid-loop failure does not lose already-swapped proofs.
        await saveProofs(walletId, keep, ProofStatus.UNSPENT)
    }

    return allNewProofs
}


const createMeltQuote = async function (bolt11: string, mintUrl: string): Promise<MeltQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.createMeltQuoteBolt11(bolt11)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'createMeltQuote' })
    }
}


const checkMeltQuote = async function (quoteId: string, mintUrl: string): Promise<MeltQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        return await wallet.checkMeltQuoteBolt11(quoteId)
    } catch (e: any) {
        throw new AppError(500, Err.CONNECTION_ERROR, e.message, { caller: 'checkMeltQuote' })
    }
}


const meltProofs = async function (
    walletId: number,
    meltQuote: MeltQuoteBolt11Response,
    mintUrl: string,
): Promise<MeltProofsResponse<MeltQuoteBolt11Response>> {
    const wallet = await getWallet(mintUrl)

    const amountNeeded = Amount.from(meltQuote.amount).add(meltQuote.fee_reserve)
    const proofs = await loadProofs(walletId)
    const totalBalance = getProofsAmount(proofs)

    if (amountNeeded.greaterThan(totalBalance)) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Insufficient balance for melt: ${totalBalance} < ${amountNeeded.toString()}`, { caller: 'meltProofs' })
    }

    // Select proofs for melt
    const { keep: proofsToKeep, send: proofsToSend } = await wallet.send(amountNeeded, proofs, { includeFees: false })

    // Determine which input proofs were consumed by the swap vs returned as-is
    const returnedSecrets = new Set([
        ...proofsToKeep.map(p => p.secret),
        ...proofsToSend.map(p => p.secret),
    ])
    const inputSecrets = new Set(proofs.map(p => p.secret))
    const swappedSecrets = proofs.map(p => p.secret).filter(s => !returnedSecrets.has(s))

    // Mark swapped input proofs as SPENT (consumed by the swap)
    if (swappedSecrets.length > 0) {
        await updateProofsStatus(walletId, swappedSecrets, ProofStatus.SPENT)
    }

    // Save genuinely new keep proofs as UNSPENT
    const newKeep = proofsToKeep.filter(p => !inputSecrets.has(p.secret))
    if (newKeep.length > 0) {
        await saveProofs(walletId, newKeep, ProofStatus.UNSPENT)
    }

    // Mark proofs reserved for melt as PENDING
    const sendSecrets = proofsToSend.map(p => p.secret)
    const existingSendSecrets = sendSecrets.filter(s => inputSecrets.has(s))
    const newSendProofs = proofsToSend.filter(p => !inputSecrets.has(p.secret))

    if (existingSendSecrets.length > 0) {
        await updateProofsStatus(walletId, existingSendSecrets, ProofStatus.PENDING)
    }
    if (newSendProofs.length > 0) {
        await saveProofs(walletId, newSendProofs, ProofStatus.PENDING)
    }

    // Attempt the melt
    try {
        const meltResponse = await wallet.meltProofsBolt11(meltQuote, proofsToSend)

        // PAID: mark melt proofs as SPENT, save change
        await updateProofsStatus(walletId, sendSecrets, ProofStatus.SPENT)

        if (meltResponse.change && meltResponse.change.length > 0) {
            await saveProofs(walletId, meltResponse.change, ProofStatus.UNSPENT)
        }

        return meltResponse
    } catch (e: any) {
        // Re-check the quote with the mint to determine proof fate
        try {
            const quoteCheck = await wallet.checkMeltQuoteBolt11(meltQuote.quote)

            if (quoteCheck.state === MeltQuoteState.PAID) {
                // Payment went through despite the error
                await updateProofsStatus(walletId, sendSecrets, ProofStatus.SPENT)
                return { quote: quoteCheck, change: [], outputData: [] }
            } else if (quoteCheck.state === MeltQuoteState.PENDING) {
                // Payment still in flight, leave proofs as PENDING
                throw new AppError(202, Err.TIMEOUT_ERROR, `Lightning payment is pending, proofs remain reserved. Check quote ${meltQuote.quote} later.`, { caller: 'meltProofs' })
            } else {
                // UNPAID: handle based on mint error code
                const isMintError = e instanceof MintOperationError
                const errorCode = isMintError ? e.code : undefined

                if (errorCode === 11002) {
                    // Proofs are pending at the mint — keep them PENDING
                    await syncProofsStateWithMint(walletId, mintUrl)
                    throw new AppError(202, Err.TIMEOUT_ERROR, `Melt failed: proofs are pending at the mint. Check quote ${meltQuote.quote} later.`, { caller: 'meltProofs' })
                } else if (errorCode === 11001) {
                    // Proofs already spent — sync all pending proofs with the mint
                    await syncProofsStateWithMint(walletId, mintUrl)
                    throw new AppError(500, Err.CONNECTION_ERROR, `Melt failed: proofs already spent. Wallet state synced with mint.`, { caller: 'meltProofs' })
                } else {
                    // Other error: safe to revert proofs back to UNSPENT
                    await updateProofsStatus(walletId, sendSecrets, ProofStatus.UNSPENT)
                    throw new AppError(500, Err.CONNECTION_ERROR, `Melt failed: ${e.message}`, { caller: 'meltProofs' })
                }
            }
        } catch (checkErr: any) {
            if (checkErr instanceof AppError) throw checkErr
            // Cannot reach mint to verify — leave as PENDING, let user retry check later
            throw new AppError(500, Err.CONNECTION_ERROR, `Melt failed and could not verify quote state: ${e.message}`, { caller: 'meltProofs' })
        }
    }
}


const syncProofsStateWithMint = async function (walletId: number, mintUrl: string): Promise<{ spent: number, pending: number, unspent: number }> {
    const wallet = await getWallet(mintUrl)
    const pendingProofs = await loadProofs(walletId, ProofStatus.PENDING)

    if (pendingProofs.length === 0) {
        return { spent: 0, pending: 0, unspent: 0 }
    }

    // Proofs carry their keyset id, which NUT-07 needs to pick the hash-to-curve variant.
    const mintStates = await wallet.checkProofsStates(pendingProofs)
    const spentSecrets: string[] = []
    const unspentSecrets: string[] = []

    for (let i = 0; i < pendingProofs.length; i++) {
        const mintState = mintStates[i]?.state
        if (mintState === CheckStateEnum.SPENT) {
            spentSecrets.push(pendingProofs[i].secret)
        } else if (mintState === CheckStateEnum.UNSPENT) {
            unspentSecrets.push(pendingProofs[i].secret)
        }
        // PENDING stays PENDING — no change needed
    }

    if (spentSecrets.length > 0) {
        await updateProofsStatus(walletId, spentSecrets, ProofStatus.SPENT)
    }
    if (unspentSecrets.length > 0) {
        await updateProofsStatus(walletId, unspentSecrets, ProofStatus.UNSPENT)
    }

    log.info('[syncProofsStateWithMint]', {
        walletId,
        total: pendingProofs.length,
        spent: spentSecrets.length,
        pending: pendingProofs.length - spentSecrets.length - unspentSecrets.length,
        unspent: unspentSecrets.length,
    })

    return {
        spent: spentSecrets.length,
        pending: pendingProofs.length - spentSecrets.length - unspentSecrets.length,
        unspent: unspentSecrets.length,
    }
}


const checkTokenState = async function (tokenStr: string): Promise<{ proofStates: ProofState[], token: Token }> {
    const token = await decodeToken(tokenStr)
    const wallet = await getWallet(token.mint)
    const proofStates = await wallet.checkProofsStates(token.proofs)
    return { proofStates, token }
}


export const WalletService = {
    getMintUrls,
    getWallet,
    getProofsAmount,
    getTokenAmount,
    decodeToken,
    getWalletBalance,
    saveProofs,
    loadProofs,
    updateProofsStatus,
    createMintQuote,
    checkMintQuote,
    mintProofs,
    sendProofs,
    receiveToken,
    createMeltQuote,
    checkMeltQuote,
    meltProofs,
    syncProofsStateWithMint,
    checkTokenState,
}
