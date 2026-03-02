import {
    Wallet,
    MintQuoteBolt11Response,
    MeltQuoteBolt11Response,
    Proof,
    Token,
    ProofState,
    MeltQuoteState,
    CheckStateEnum,
    MintOperationError,
    OutputConfig,
    getDecodedToken,
} from '@cashu/cashu-ts'
import { ProofStatus } from '@prisma/client'
import prisma from '../utils/prismaClient'
import AppError, { Err } from '../utils/AppError'
import { log } from './logService'

const _wallets = new Map<string, Wallet>()

const getMintUrls = function (): string[] {
    const raw = process.env.MINT_URLS || ''
    return raw.split(',').map(u => u.trim()).filter(u => u.length > 0)
}

const getWallet = async function (mintUrl: string): Promise<Wallet> {
    if (_wallets.has(mintUrl)) {
        return _wallets.get(mintUrl)!
    }

    const unit = process.env.UNIT || 'sat'

    log.debug('[getWallet] Creating new wallet instance', { mintUrl, unit })

    const cashuWallet = new Wallet(mintUrl, { unit })
    await cashuWallet.loadMint()
    _wallets.set(mintUrl, cashuWallet)

    return cashuWallet
}


const getProofsAmount = function (proofs: Array<Proof>): number {
    let totalAmount = 0
    for (const proof of proofs) {
        totalAmount += proof.amount
    }
    return totalAmount
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


const saveProofs = async function (walletId: number, proofs: Proof[], status: ProofStatus = ProofStatus.UNSPENT) {
    for (const proof of proofs) {
        await prisma.proof.create({
            data: {
                walletId,
                proofId: proof.id,
                amount: proof.amount,
                secret: proof.secret,
                C: proof.C,
                dleq: proof.dleq ? JSON.stringify(proof.dleq) : null,
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
        amount: p.amount,
        secret: p.secret,
        C: p.C,
        dleq: p.dleq ? JSON.parse(p.dleq) : undefined,
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


const createMintQuote = async function (amount: number, mintUrl: string): Promise<MintQuoteBolt11Response> {
    try {
        const wallet = await getWallet(mintUrl)
        const quote = await wallet.createMintQuoteBolt11(amount)
        log.debug('[createMintQuote]', { quote: quote.quote, amount })
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


const mintProofs = async function (amount: number, quoteId: string, mintUrl: string): Promise<Proof[]> {
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
    const decoded = getDecodedToken(tokenStr)
    if (decoded.mint !== mintUrl) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Token mint '${decoded.mint}' does not match wallet mint '${mintUrl}'`, { caller: 'receiveToken' })
    }
    const wallet = await getWallet(mintUrl)

    if (decoded.proofs.length <= SWAP_BATCH_SIZE) {
        const newProofs = await wallet.receive(tokenStr)
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
    }

    await saveProofs(walletId, allNewProofs, ProofStatus.UNSPENT)
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
): Promise<{ quote: MeltQuoteBolt11Response, change: Proof[] }> {
    const wallet = await getWallet(mintUrl)

    const amountNeeded = meltQuote.amount + meltQuote.fee_reserve
    const proofs = await loadProofs(walletId)
    const totalBalance = getProofsAmount(proofs)

    if (totalBalance < amountNeeded) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Insufficient balance for melt: ${totalBalance} < ${amountNeeded}`, { caller: 'meltProofs' })
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
                return { quote: quoteCheck, change: [] }
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
    const token = getDecodedToken(tokenStr)
    const wallet = await getWallet(token.mint)
    const proofStates = await wallet.checkProofsStates(token.proofs)
    return { proofStates, token }
}


export const WalletService = {
    getMintUrls,
    getWallet,
    getProofsAmount,
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
