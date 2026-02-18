import 'dotenv/config'
import { Wallet as PrismaWallet } from '@prisma/client'
import { FastifyRequest, FastifyPluginCallback, FastifyReply } from 'fastify'
import {
    MintQuoteState,
    MeltQuoteState,
    getDecodedToken,
    getEncodedTokenV4,
    CheckStateEnum,
    decodePaymentRequest,
} from '@cashu/cashu-ts'
import { decode as bolt11Decode } from '@gandlaf21/bolt11-decode'
import { bearerAuthHandler } from '../handlers/bearerAuth'
import { log } from '../services/logService'
import { WalletService } from '../services/walletService'
import { NostrService } from '../services/nostrService'
import { getExchangeRate, isSupportedCurrency } from '../services/exchangeRateService'
import AppError, { Err } from '../utils/AppError'


// Helper to get the wallet from the request (attached by bearerAuthHandler)
function getAuthWallet(req: FastifyRequest): PrismaWallet {
    return (req as any).wallet as PrismaWallet
}


// Helper to resolve the effective limit (per-wallet overrides global)
function effectiveLimit(walletLimit: number | null, globalEnvKey: string, fallback: number): number {
    const global = parseInt(process.env[globalEnvKey] || String(fallback))
    if (walletLimit !== null && walletLimit !== undefined) {
        return Math.min(walletLimit, global)
    }
    return global
}


function validateUnit(wallet: PrismaWallet, unit: string | undefined, caller: string, reqId: string) {
    if (!unit) {
        throw new AppError(400, Err.VALIDATION_ERROR, 'Unit is required', { caller, reqId })
    }
    if (unit !== wallet.unit) {
        throw new AppError(400, Err.VALIDATION_ERROR, `Unit '${unit}' does not match wallet unit '${wallet.unit}'`, { caller, reqId })
    }
}


export const protectedRoutes: FastifyPluginCallback = (instance, opts, done) => {

    instance.addHook('onRequest', async (request, reply) => {
        await bearerAuthHandler(request, reply)
    })


    // GET /v1/wallet
    instance.get('/wallet', async (req: FastifyRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)

        log.info('GET /v1/wallet', { walletId: wallet.id, reqId: req.id })

        return {
            name: wallet.name || '',
            access_key: wallet.accessKey,
            mint: wallet.mint,
            unit: wallet.unit,
            balance,
            pending_balance: pendingBalance,
            limits: (wallet.maxBalance || wallet.maxSend || wallet.maxPay) ? {
                max_balance: wallet.maxBalance,
                max_send: wallet.maxSend,
                max_pay: wallet.maxPay,
            } : undefined,
        }
    })


    // POST /v1/wallet/deposit
    type DepositRequest = FastifyRequest<{
        Body: {
            amount: number
            unit: string
        }
    }>

    instance.post('/wallet/deposit', async (req: DepositRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { amount, unit } = req.body

        validateUnit(wallet, unit, 'Deposit', req.id)

        if (!amount || amount <= 0) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Amount must be a positive integer', { caller: 'Deposit', reqId: req.id })
        }

        const maxBalance = effectiveLimit(wallet.maxBalance, 'MAX_BALANCE', 100000)
        const { balance } = await WalletService.getWalletBalance(wallet.id)

        if (balance + amount > maxBalance) {
            throw new AppError(400, Err.LIMIT_ERROR, `Deposit would exceed max balance of ${maxBalance}`, { caller: 'Deposit', reqId: req.id })
        }

        const quote = await WalletService.createMintQuote(amount)

        log.info('POST /v1/wallet/deposit', { walletId: wallet.id, amount, quote: quote.quote, reqId: req.id })

        return {
            quote: quote.quote,
            request: quote.request,
            state: quote.state,
            expiry: quote.expiry,
        }
    })


    // GET /v1/wallet/deposit/:quote
    type DepositCheckRequest = FastifyRequest<{
        Params: { quote: string }
    }>

    instance.get('/wallet/deposit/:quote', async (req: DepositCheckRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { quote: quoteId } = req.params

        const quote = await WalletService.checkMintQuote(quoteId)

        // If paid, mint the proofs automatically
        if (quote.state === MintQuoteState.PAID) {
            try {
                const proofs = await WalletService.mintProofs(quote.amount, quote.quote)
                await WalletService.saveProofs(wallet.id, proofs)

                log.info('GET /v1/wallet/deposit/:quote - Minted proofs', {
                    walletId: wallet.id,
                    quoteId,
                    amount: quote.amount,
                    reqId: req.id,
                })
            } catch (e: any) {
                log.warn('GET /v1/wallet/deposit/:quote - Mint proofs failed', {
                    quoteId,
                    error: e.message,
                    reqId: req.id,
                })
            }
        }

        log.info('GET /v1/wallet/deposit/:quote', { walletId: wallet.id, quoteId, state: quote.state, reqId: req.id })

        return {
            quote: quote.quote,
            request: quote.request,
            state: quote.state,
            expiry: quote.expiry,
        }
    })


    // POST /v1/wallet/send
    type SendRequest = FastifyRequest<{
        Body: {
            amount: number
            unit: string
            cashu_request?: string
            memo?: string
            lock_to_pubkey?: string
        }
    }>

    instance.post('/wallet/send', async (req: SendRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { amount, unit, memo, lock_to_pubkey, cashu_request } = req.body

        validateUnit(wallet, unit, 'Send', req.id)

        if (cashu_request) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Paying of cashu payment requests is not yet supported.', { caller: 'Send', reqId: req.id })
        }

        if (!amount || amount <= 0) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Amount must be a positive integer', { caller: 'Send', reqId: req.id })
        }

        const maxSend = effectiveLimit(wallet.maxSend, 'MAX_SEND', 50000)
        if (amount > maxSend) {
            throw new AppError(400, Err.LIMIT_ERROR, `Amount ${amount} exceeds max send limit of ${maxSend}`, { caller: 'Send', reqId: req.id })
        }

        let p2pkPubkey: string | undefined
        if (lock_to_pubkey) {
            p2pkPubkey = NostrService.normalizePubkey(lock_to_pubkey)
        }

        const { send } = await WalletService.sendProofs(wallet.id, amount, p2pkPubkey)
        const mintUrl = process.env.MINT_URL || ''

        const token = getEncodedTokenV4({
            mint: mintUrl,
            proofs: send,
            memo,
            unit: wallet.unit,
        })

        log.info('POST /v1/wallet/send', { walletId: wallet.id, amount, reqId: req.id })

        return {
            token,
            amount: WalletService.getProofsAmount(send),
            unit: wallet.unit,
            memo,
        }
    })


    // POST /v1/wallet/check
    type CheckRequest = FastifyRequest<{
        Body: {
            token: string
        }
    }>

    instance.post('/wallet/check', async (req: CheckRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { token: tokenStr } = req.body

        if (!tokenStr) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Token is required', { caller: 'Check', reqId: req.id })
        }

        const { proofStates, token } = await WalletService.checkTokenState(tokenStr)

        // Determine overall state
        const states = proofStates.map(s => s.state)
        let overallState: string = 'UNKNOWN'

        if (states.every(s => s === CheckStateEnum.UNSPENT)) {
            overallState = 'UNSPENT'
        } else if (states.every(s => s === CheckStateEnum.SPENT)) {
            overallState = 'SPENT'
        } else if (states.every(s => s === CheckStateEnum.PENDING)) {
            overallState = 'PENDING'
        } else {
            overallState = 'MIXED'
        }

        // Update local proof status based on mint state
        const spentSecrets = token.proofs
            .filter((_, i) => proofStates[i]?.state === CheckStateEnum.SPENT)
            .map(p => p.secret)

        if (spentSecrets.length > 0) {
            await WalletService.updateProofsStatus(wallet.id, spentSecrets, 'SPENT')
        }

        const pendingSecrets = token.proofs
            .filter((_, i) => proofStates[i]?.state === CheckStateEnum.PENDING)
            .map(p => p.secret)

        if (pendingSecrets.length > 0) {
            await WalletService.updateProofsStatus(wallet.id, pendingSecrets, 'PENDING')
        }

        log.info('POST /v1/wallet/check', { walletId: wallet.id, state: overallState, reqId: req.id })

        return {
            amount: WalletService.getProofsAmount(token.proofs),
            unit: token.unit || wallet.unit,
            memo: token.memo,
            state: overallState,
            mint_proof_states: proofStates,
        }
    })


    // POST /v1/wallet/decode
    type DecodeRequest = FastifyRequest<{
        Body: {
            type: string
            data: string
        }
    }>

    instance.post('/wallet/decode', async (req: DecodeRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { type, data } = req.body

        if (!type || !data) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Both type and data are required', { caller: 'Decode', reqId: req.id })
        }

        let decoded: any

        switch (type) {
            case 'CASHU_TOKEN_V4':
            case 'CASHU_TOKEN_V3': {
                const token = getDecodedToken(data)
                decoded = {
                    mint: token.mint,
                    unit: token.unit,
                    memo: token.memo,
                    amount: WalletService.getProofsAmount(token.proofs),
                    proofs_count: token.proofs.length,
                }
                break
            }

            case 'BOLT11_REQUEST': {
                const invoice = bolt11Decode(data)
                decoded = invoice
                break
            }

            case 'CASHU_REQUEST': {
                const paymentRequest = decodePaymentRequest(data)
                decoded = {
                    id: paymentRequest.id,
                    amount: paymentRequest.amount,
                    unit: paymentRequest.unit,
                    mints: paymentRequest.mints,
                    description: paymentRequest.description,
                    single_use: paymentRequest.singleUse,
                }
                break
            }

            default:
                throw new AppError(400, Err.VALIDATION_ERROR, `Unsupported type: ${type}`, { caller: 'Decode', reqId: req.id })
        }

        log.info('POST /v1/wallet/decode', { walletId: wallet.id, type, reqId: req.id })

        return { type, decoded }
    })


    // POST /v1/wallet/pay
    type PayRequest = FastifyRequest<{
        Body: {
            lightning_address?: string
            bolt11_request?: string
            amount: number
            unit: string
        }
    }>

    instance.post('/wallet/pay', async (req: PayRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { bolt11_request, lightning_address, amount, unit } = req.body

        validateUnit(wallet, unit, 'Pay', req.id)

        if (!bolt11_request && !lightning_address) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Either bolt11_request or lightning_address is required', { caller: 'Pay', reqId: req.id })
        }

        const maxPay = effectiveLimit(wallet.maxPay, 'MAX_PAY', 50000)
        if (amount && amount > maxPay) {
            throw new AppError(400, Err.LIMIT_ERROR, `Amount ${amount} exceeds max pay limit of ${maxPay}`, { caller: 'Pay', reqId: req.id })
        }

        let invoice = bolt11_request

        // Resolve lightning address to bolt11 invoice
        if (lightning_address && !invoice) {
            try {
                const [name, domain] = lightning_address.split('@')
                const lnurlResponse = await fetch(`https://${domain}/.well-known/lnurlp/${name}`)
                const lnurlData = await lnurlResponse.json() as any

                if (lnurlData.status === 'ERROR') {
                    throw new Error(lnurlData.reason || 'LNURL error')
                }

                const amountMsat = amount * 1000
                const callbackUrl = new URL(lnurlData.callback)
                callbackUrl.searchParams.set('amount', String(amountMsat))

                const invoiceResponse = await fetch(callbackUrl.toString())
                const invoiceData = await invoiceResponse.json() as any

                if (invoiceData.status === 'ERROR') {
                    throw new Error(invoiceData.reason || 'Failed to get invoice from lightning address')
                }

                invoice = invoiceData.pr
            } catch (e: any) {
                throw new AppError(400, Err.CONNECTION_ERROR, `Failed to resolve lightning address: ${e.message}`, { caller: 'Pay', reqId: req.id })
            }
        }

        if (!invoice) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Could not resolve a bolt11 invoice', { caller: 'Pay', reqId: req.id })
        }

        const meltQuote = await WalletService.createMeltQuote(invoice)
        const meltResponse = await WalletService.meltProofs(wallet.id, meltQuote)

        log.info('POST /v1/wallet/pay', {
            walletId: wallet.id,
            quoteId: meltResponse.quote.quote,
            amount: meltResponse.quote.amount,
            fee: meltResponse.quote.fee_reserve,
            state: meltResponse.quote.state,
            reqId: req.id,
        })

        return {
            quote: meltResponse.quote.quote,
            amount: meltResponse.quote.amount,
            fee_reserve: meltResponse.quote.fee_reserve,
            state: meltResponse.quote.state,
            payment_preimage: meltResponse.quote.payment_preimage,
            expiry: meltResponse.quote.expiry,
        }
    })


    // GET /v1/wallet/pay/:quote
    type PayCheckRequest = FastifyRequest<{
        Params: { quote: string }
    }>

    instance.get('/wallet/pay/:quote', async (req: PayCheckRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { quote: quoteId } = req.params

        const quote = await WalletService.checkMeltQuote(quoteId)

        log.info('GET /v1/wallet/pay/:quote', { walletId: wallet.id, quoteId, state: quote.state, reqId: req.id })

        return {
            quote: quote.quote,
            amount: quote.amount,
            fee_reserve: quote.fee_reserve,
            state: quote.state,
            payment_preimage: quote.payment_preimage,
            expiry: quote.expiry,
        }
    })


    // POST /v1/wallet/receive
    type ReceiveRequest = FastifyRequest<{
        Body: {
            token: string
        }
    }>

    instance.post('/wallet/receive', async (req: ReceiveRequest, res: FastifyReply) => {
        const wallet = getAuthWallet(req)
        const { token: tokenStr } = req.body

        if (!tokenStr) {
            throw new AppError(400, Err.VALIDATION_ERROR, 'Token is required', { caller: 'Receive', reqId: req.id })
        }

        const maxBalance = effectiveLimit(wallet.maxBalance, 'MAX_BALANCE', 100000)
        const { balance: currentBalance } = await WalletService.getWalletBalance(wallet.id)

        // Decode token to check amount before receiving
        const decoded = getDecodedToken(tokenStr)
        const tokenAmount = WalletService.getProofsAmount(decoded.proofs)

        if (currentBalance + tokenAmount > maxBalance) {
            throw new AppError(400, Err.LIMIT_ERROR, `Receiving ${tokenAmount} would exceed max balance of ${maxBalance}`, { caller: 'Receive', reqId: req.id })
        }

        const newProofs = await WalletService.receiveToken(wallet.id, tokenStr)
        const amount = WalletService.getProofsAmount(newProofs)
        const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)

        log.info('POST /v1/wallet/receive', { walletId: wallet.id, amount, reqId: req.id })

        return {
            amount,
            unit: wallet.unit,
            balance,
            pending_balance: pendingBalance,
        }
    })


    // GET /v1/rate/:currency
    type RateRequest = FastifyRequest<{
        Params: { currency: string }
    }>

    instance.get('/rate/:currency', async (req: RateRequest, res: FastifyReply) => {
        const { currency } = req.params

        if (!isSupportedCurrency(currency)) {
            throw new AppError(400, Err.VALIDATION_ERROR, `Unsupported currency: ${currency}`, { caller: 'Rate', reqId: req.id })
        }

        try {
            const rateResponse = await getExchangeRate(currency, req.id)
            log.info('GET /v1/rate/' + currency, { rateResponse, reqId: req.id })
            return rateResponse
        } catch (e: any) {
            throw new AppError(404, Err.NOTFOUND_ERROR, e.message, { caller: 'Rate', reqId: req.id })
        }
    })

    done()
}
