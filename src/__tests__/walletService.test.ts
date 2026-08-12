import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Amount, MeltQuoteState, CheckStateEnum, MintOperationError } from '@cashu/cashu-ts'
import { ProofStatus } from '@prisma/client'

// NUT-02 v2 keyset ids are 33 bytes (66 hex chars) and are carried truncated inside cashuB tokens.
const KEYSET_V2_ID = '01' + 'ab'.repeat(32)

// ── hoisted mock fns ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    walletLoadMint: vi.fn(),
    walletSend: vi.fn(),
    walletReceive: vi.fn(),
    walletCheckProofsStates: vi.fn(),
    walletCreateMintQuoteBolt11: vi.fn(),
    walletCheckMintQuoteBolt11: vi.fn(),
    walletMintProofsBolt11: vi.fn(),
    walletCreateMeltQuoteBolt11: vi.fn(),
    walletCheckMeltQuoteBolt11: vi.fn(),
    walletMeltProofsBolt11: vi.fn(),
    walletBindKeyset: vi.fn(),
    getAllKeysetIds: vi.fn(),
    getCheapestKeyset: vi.fn(),
    getKeyset: vi.fn(),
    getDecodedToken: vi.fn(),
    getTokenMetadata: vi.fn(),
    prismaProofAggregate: vi.fn(),
    prismaProofFindMany: vi.fn(),
    prismaProofCreate: vi.fn(),
    prismaProofUpdateMany: vi.fn(),
    WalletCtor: vi.fn(),
}))

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../services/logService', () => ({
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@cashu/cashu-ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()
    return {
        ...actual,
        getDecodedToken: mocks.getDecodedToken,
        getTokenMetadata: mocks.getTokenMetadata,
        Wallet: mocks.WalletCtor,
    }
})

vi.mock('../utils/prismaClient', () => ({
    default: {
        proof: {
            aggregate: mocks.prismaProofAggregate,
            findMany: mocks.prismaProofFindMany,
            create: mocks.prismaProofCreate,
            updateMany: mocks.prismaProofUpdateMany,
        },
        wallet: { create: vi.fn(), findUnique: vi.fn() },
    },
}))

// ── import service after mocks ─────────────────────────────────────────────────

import { WalletService } from '../services/walletService'

// ── fixtures ───────────────────────────────────────────────────────────────────

// Proofs as cashu-ts v4 returns them: amounts are Amount value objects, not numbers.
const makeProof = (secret: string, amount = 100) => ({
    id: KEYSET_V2_ID, amount: Amount.from(amount), secret, C: `C-${secret}`,
})

// Proofs as they come back from Prisma: amounts are plain integers.
const makeDbProof = (secret: string, amount = 100) => ({
    id: 1, walletId: 1, proofId: KEYSET_V2_ID, amount, secret,
    C: `C-${secret}`, dleq: null, p2pkE: null, witness: null, status: ProofStatus.UNSPENT,
    createdAt: new Date(),
})

// Reset every mock and restore the defaults that getWallet needs to consider its cached
// keyset healthy. Nested suites layer their own fixtures on top of this.
beforeEach(() => {
    vi.resetAllMocks()

    mocks.WalletCtor.mockImplementation(() => ({
        loadMint: mocks.walletLoadMint,
        send: mocks.walletSend,
        receive: mocks.walletReceive,
        checkProofsStates: mocks.walletCheckProofsStates,
        createMintQuoteBolt11: mocks.walletCreateMintQuoteBolt11,
        checkMintQuoteBolt11: mocks.walletCheckMintQuoteBolt11,
        mintProofsBolt11: mocks.walletMintProofsBolt11,
        createMeltQuoteBolt11: mocks.walletCreateMeltQuoteBolt11,
        checkMeltQuoteBolt11: mocks.walletCheckMeltQuoteBolt11,
        meltProofsBolt11: mocks.walletMeltProofsBolt11,
        getKeyset: mocks.getKeyset,
        bindKeyset: mocks.walletBindKeyset,
        keyChain: {
            getAllKeysetIds: mocks.getAllKeysetIds,
            getCheapestKeyset: mocks.getCheapestKeyset,
        },
    }))

    mocks.walletLoadMint.mockResolvedValue(undefined)
    mocks.getKeyset.mockReturnValue({ id: KEYSET_V2_ID, isActive: true, expiry: undefined })
    mocks.getAllKeysetIds.mockReturnValue([KEYSET_V2_ID])
    mocks.getCheapestKeyset.mockReturnValue({ id: KEYSET_V2_ID })
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('WalletService.getProofsAmount', () => {
    it('sums proof amounts', () => {
        const proofs = [makeProof('a', 100), makeProof('b', 200), makeProof('c', 50)]
        expect(WalletService.getProofsAmount(proofs)).toBe(350)
    })

    it('returns 0 for empty array', () => {
        expect(WalletService.getProofsAmount([])).toBe(0)
    })
})

describe('WalletService.getWalletBalance', () => {
    it('returns unspent and pending balance', async () => {
        mocks.prismaProofAggregate
            .mockResolvedValueOnce({ _sum: { amount: 5000 } })
            .mockResolvedValueOnce({ _sum: { amount: 300 } })

        const result = await WalletService.getWalletBalance(1)
        expect(result.balance).toBe(5000)
        expect(result.pendingBalance).toBe(300)
    })

    it('returns 0 when no proofs exist', async () => {
        mocks.prismaProofAggregate
            .mockResolvedValueOnce({ _sum: { amount: null } })
            .mockResolvedValueOnce({ _sum: { amount: null } })

        const result = await WalletService.getWalletBalance(1)
        expect(result.balance).toBe(0)
        expect(result.pendingBalance).toBe(0)
    })
})

describe('WalletService.syncProofsStateWithMint', () => {
    it('returns zeros when no pending proofs exist', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([])
        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result).toEqual({ spent: 0, pending: 0, unspent: 0 })
        expect(mocks.walletCheckProofsStates).not.toHaveBeenCalled()
    })

    it('marks SPENT proofs correctly', async () => {
        const pendingProofs = [makeDbProof('s1'), makeDbProof('s2')]
        mocks.prismaProofFindMany.mockResolvedValue(pendingProofs)
        mocks.walletCheckProofsStates.mockResolvedValue([
            { state: CheckStateEnum.SPENT },
            { state: CheckStateEnum.SPENT },
        ])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result.spent).toBe(2)
        expect(result.unspent).toBe(0)
        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith({
            where: { walletId: 1, secret: { in: ['s1', 's2'] } },
            data: { status: ProofStatus.SPENT },
        })
    })

    it('marks UNSPENT proofs correctly', async () => {
        const pendingProofs = [makeDbProof('s1'), makeDbProof('s2')]
        mocks.prismaProofFindMany.mockResolvedValue(pendingProofs)
        mocks.walletCheckProofsStates.mockResolvedValue([
            { state: CheckStateEnum.UNSPENT },
            { state: CheckStateEnum.UNSPENT },
        ])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result.unspent).toBe(2)
        expect(result.spent).toBe(0)
        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith({
            where: { walletId: 1, secret: { in: ['s1', 's2'] } },
            data: { status: ProofStatus.UNSPENT },
        })
    })

    it('leaves PENDING proofs untouched', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1')])
        mocks.walletCheckProofsStates.mockResolvedValue([{ state: CheckStateEnum.PENDING }])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result).toEqual({ spent: 0, unspent: 0, pending: 1 })
        expect(mocks.prismaProofUpdateMany).not.toHaveBeenCalled()
    })

    it('handles mixed states correctly', async () => {
        const pendingProofs = [makeDbProof('s1'), makeDbProof('s2'), makeDbProof('s3')]
        mocks.prismaProofFindMany.mockResolvedValue(pendingProofs)
        mocks.walletCheckProofsStates.mockResolvedValue([
            { state: CheckStateEnum.SPENT },
            { state: CheckStateEnum.UNSPENT },
            { state: CheckStateEnum.PENDING },
        ])

        const result = await WalletService.syncProofsStateWithMint(1, 'https://testmint.example.com')
        expect(result).toEqual({ spent: 1, unspent: 1, pending: 1 })
    })
})

describe('WalletService.sendProofs', () => {
    const WALLET_ID = 1

    it('throws VALIDATION_ERROR when balance insufficient', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 50)])

        await expect(WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com'))
            .rejects.toMatchObject({ name: 'VALIDATION_ERROR' })
    })

    it('passes P2PK pubkey as outputConfig to wallet.send', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 200)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 100)],
            send: [makeProof('send1', 100)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})

        const pubkey = '02' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        await WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com', pubkey)

        expect(mocks.walletSend).toHaveBeenCalledWith(
            100,
            expect.any(Array),
            { includeFees: true },
            { send: { type: 'p2pk', options: { pubkey } } },
        )
    })

    it('calls wallet.send without outputConfig when no pubkey', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 200)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 100)],
            send: [makeProof('send1', 100)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})

        await WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com')

        expect(mocks.walletSend).toHaveBeenCalledWith(
            100, expect.any(Array), { includeFees: true }, undefined,
        )
    })

    it('sends proofs whose keyset id is a NUT-02 v2 id', async () => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 200)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 100)],
            send: [makeProof('send1', 100)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})

        await WalletService.sendProofs(WALLET_ID, 100, 'https://testmint.example.com')

        // Proofs loaded from the DB must reach cashu-ts with their full 66-char keyset id.
        const [, sentProofs] = mocks.walletSend.mock.calls[0]
        expect(sentProofs[0].id).toBe(KEYSET_V2_ID)
        expect(sentProofs[0].amount).toBeInstanceOf(Amount)

        // ...and new proofs must be persisted with it intact.
        expect(mocks.prismaProofCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ proofId: KEYSET_V2_ID }) })
        )
    })
})

describe('WalletService.decodeToken — NUT-02 v2 keyset resolution', () => {
    const MINT = 'https://testmint.example.com'
    const TOKEN = 'cashuBtest'

    beforeEach(() => {
        mocks.getTokenMetadata.mockReturnValue({ mint: MINT, unit: 'sat', amount: Amount.from(100), incompleteProofs: [] })
    })

    it('passes the mint keyset ids so short v2 ids can be expanded', async () => {
        mocks.getDecodedToken.mockReturnValue({ mint: MINT, unit: 'sat', proofs: [makeProof('a')] })

        await WalletService.decodeToken(TOKEN)

        expect(mocks.getDecodedToken).toHaveBeenCalledWith(TOKEN, [KEYSET_V2_ID])
    })

    it('refreshes keysets and retries when a short id maps to no known keyset', async () => {
        const rotatedId = '01' + 'cd'.repeat(32)
        mocks.getDecodedToken
            .mockImplementationOnce(() => { throw new Error("Couldn't map short keyset ID 01cd to any known keysets") })
            .mockReturnValueOnce({ mint: MINT, unit: 'sat', proofs: [makeProof('a')] })
        mocks.getAllKeysetIds
            .mockReturnValueOnce([KEYSET_V2_ID])
            .mockReturnValue([KEYSET_V2_ID, rotatedId])

        const token = await WalletService.decodeToken(TOKEN)

        expect(token.mint).toBe(MINT)
        expect(mocks.walletLoadMint).toHaveBeenCalledWith(true)
        expect(mocks.getDecodedToken).toHaveBeenNthCalledWith(2, TOKEN, [KEYSET_V2_ID, rotatedId])
    })
})

describe('WalletService.receiveToken', () => {
    const MINT = 'https://testmint.example.com'

    it('rejects a token from a different mint before touching its keysets', async () => {
        mocks.getTokenMetadata.mockReturnValue({
            mint: 'https://othermint.example.com', unit: 'sat', amount: Amount.from(100), incompleteProofs: [],
        })

        await expect(WalletService.receiveToken(1, 'cashuBtest', MINT))
            .rejects.toMatchObject({ name: 'VALIDATION_ERROR' })

        expect(mocks.getDecodedToken).not.toHaveBeenCalled()
    })

    it('receives the decoded token so expanded keyset ids are used for the swap', async () => {
        const decoded = { mint: MINT, unit: 'sat', proofs: [makeProof('a')] }
        mocks.getTokenMetadata.mockReturnValue({ mint: MINT, unit: 'sat', amount: Amount.from(100), incompleteProofs: [] })
        mocks.getDecodedToken.mockReturnValue(decoded)
        mocks.walletReceive.mockResolvedValue([makeProof('new1')])
        mocks.prismaProofCreate.mockResolvedValue({})

        await WalletService.receiveToken(1, 'cashuBtest', MINT)

        expect(mocks.walletReceive).toHaveBeenCalledWith(decoded)
    })

    // A v1 (`00`-prefixed) keyset id decodes without consulting the keychain, so a token from a
    // keyset the mint rotated to gets all the way to the swap before anything notices.
    it('refreshes keysets when the token uses a keyset the wallet has not loaded', async () => {
        const rotatedId = '00' + 'ef'.repeat(7)
        const rotatedProof = { ...makeProof('a'), id: rotatedId }
        mocks.getTokenMetadata.mockReturnValue({ mint: MINT, unit: 'sat', amount: Amount.from(100), incompleteProofs: [] })
        mocks.getDecodedToken.mockReturnValue({ mint: MINT, unit: 'sat', proofs: [rotatedProof] })
        mocks.getAllKeysetIds
            .mockReturnValueOnce([KEYSET_V2_ID])           // decodeToken: rotated keyset still unknown
            .mockReturnValueOnce([KEYSET_V2_ID])           // ensureKeysetsKnown: detects it
            .mockReturnValue([KEYSET_V2_ID, rotatedId])    // after the refresh
        mocks.walletReceive.mockResolvedValue([makeProof('new1')])
        mocks.prismaProofCreate.mockResolvedValue({})

        await WalletService.receiveToken(1, 'cashuBtest', MINT)

        expect(mocks.walletLoadMint).toHaveBeenCalledWith(true)
        expect(mocks.walletReceive).toHaveBeenCalled()
    })

    it('fails cleanly when the keyset is still unknown after a refresh', async () => {
        const bogusProof = { ...makeProof('a'), id: '00' + 'ff'.repeat(7) }
        mocks.getTokenMetadata.mockReturnValue({ mint: MINT, unit: 'sat', amount: Amount.from(100), incompleteProofs: [] })
        mocks.getDecodedToken.mockReturnValue({ mint: MINT, unit: 'sat', proofs: [bogusProof] })
        mocks.getAllKeysetIds.mockReturnValue([KEYSET_V2_ID])

        await expect(WalletService.receiveToken(1, 'cashuBtest', MINT))
            .rejects.toMatchObject({ statusCode: 400, name: 'VALIDATION_ERROR' })

        expect(mocks.walletReceive).not.toHaveBeenCalled()
    })
})

describe('WalletService.meltProofs — error handling', () => {
    const WALLET_ID = 1
    const MELT_QUOTE = {
        quote: 'mq1', amount: Amount.from(500), fee_reserve: Amount.from(10),
        state: MeltQuoteState.UNPAID, expiry: 3600,
        unit: 'sat', request: 'lnbc...', payment_preimage: null,
    }

    beforeEach(() => {
        mocks.prismaProofFindMany.mockResolvedValue([makeDbProof('s1', 1000)])
        mocks.walletSend.mockResolvedValue({
            keep: [makeProof('k1', 490)],
            send: [makeProof('send1', 510)],
        })
        mocks.prismaProofCreate.mockResolvedValue({})
        mocks.prismaProofUpdateMany.mockResolvedValue({})
    })

    it('marks send proofs SPENT and saves change on successful melt', async () => {
        mocks.walletMeltProofsBolt11.mockResolvedValue({
            quote: { ...MELT_QUOTE, state: MeltQuoteState.PAID, payment_preimage: 'pi' },
            change: [makeProof('change1', 5)],
        })

        const result = await WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com')
        expect(result.quote.state).toBe(MeltQuoteState.PAID)
        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: ProofStatus.SPENT } })
        )
        expect(mocks.prismaProofCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: ProofStatus.UNSPENT }),
            })
        )
    })

    it('throws 202 TIMEOUT_ERROR when quote is PENDING after melt failure', async () => {
        mocks.walletMeltProofsBolt11.mockRejectedValue(new Error('network error'))
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.PENDING,
        })

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 202, name: 'TIMEOUT_ERROR' })
    })

    it('reverts send proofs to UNSPENT on generic UNPAID error', async () => {
        mocks.walletMeltProofsBolt11.mockRejectedValue(new Error('some generic error'))
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.UNPAID,
        })

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 500, name: 'CONNECTION_ERROR' })

        expect(mocks.prismaProofUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: ProofStatus.UNSPENT } })
        )
    })

    it('throws 202 TIMEOUT_ERROR on mint error code 11002 (proofs pending)', async () => {
        const mintErr = new MintOperationError(11002, 'proofs pending')
        mocks.walletMeltProofsBolt11.mockRejectedValue(mintErr)
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.UNPAID,
        })
        // second findMany is for syncProofsStateWithMint — return empty so it's a no-op
        mocks.prismaProofFindMany
            .mockResolvedValueOnce([makeDbProof('s1', 1000)])
            .mockResolvedValueOnce([])

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 202, name: 'TIMEOUT_ERROR' })
    })

    it('calls syncProofsStateWithMint on mint error code 11001 (proofs already spent)', async () => {
        const mintErr = new MintOperationError(11001, 'proofs already spent')
        mocks.walletMeltProofsBolt11.mockRejectedValue(mintErr)
        mocks.walletCheckMeltQuoteBolt11.mockResolvedValue({
            ...MELT_QUOTE, state: MeltQuoteState.UNPAID,
        })
        mocks.walletCheckProofsStates.mockResolvedValue([{ state: CheckStateEnum.SPENT }])
        mocks.prismaProofFindMany
            .mockResolvedValueOnce([makeDbProof('s1', 1000)])
            .mockResolvedValueOnce([makeDbProof('s1', 1000)])

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 500, name: 'CONNECTION_ERROR' })

        expect(mocks.walletCheckProofsStates).toHaveBeenCalled()
    })

    it('throws 500 CONNECTION_ERROR when mint is unreachable after melt failure', async () => {
        mocks.walletMeltProofsBolt11.mockRejectedValue(new Error('connection refused'))
        mocks.walletCheckMeltQuoteBolt11.mockRejectedValue(new Error('timeout'))

        await expect(WalletService.meltProofs(WALLET_ID, MELT_QUOTE, 'https://testmint.example.com'))
            .rejects.toMatchObject({ statusCode: 500, name: 'CONNECTION_ERROR' })
    })
})
