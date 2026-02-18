import 'dotenv/config'
import crypto from 'crypto'
import { FastifyRequest, FastifyPluginCallback, FastifyReply } from 'fastify'
import prisma from '../utils/prismaClient'
import { log } from '../services/logService'
import { WalletService } from '../services/walletService'
import AppError, { Err } from '../utils/AppError'

const limitsSchema = {
    type: 'object',
    properties: {
        max_balance:                  { type: 'integer' },
        max_send:                     { type: 'integer' },
        max_pay:                      { type: 'integer' },
        rate_limit_max:               { type: 'integer', description: 'Max requests per time window (global)' },
        rate_limit_create_wallet_max: { type: 'integer', description: 'Max wallet creations per time window per IP' },
        rate_limit_window:            { type: 'string',  description: 'Rate-limit time window (e.g. "1 minute")' },
    },
}

export const publicRoutes: FastifyPluginCallback = (instance, opts, done) => {

    // GET /v1/info
    instance.get('/info', {
        schema: {
            description: 'Returns machine-readable information about the wallet service: status, mint URL, supported unit, and global balance/payment limits.',
            tags: ['Info'],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', example: 'operational' },
                        help:   { type: 'string' },
                        terms:  { type: 'string' },
                        unit:   { type: 'string', enum: ['sat', 'msat'] },
                        mint:   { type: 'string' },
                        limits: limitsSchema,
                    },
                },
            },
        },
    }, async (req: FastifyRequest, res: FastifyReply) => {
        const unit = process.env.UNIT || 'sat'
        const mintUrl = process.env.MINT_URL || ''

        const info = {
            status: process.env.SERVICE_STATUS || 'operational',
            help: process.env.SERVICE_HELP || '',
            terms: process.env.SERVICE_TERMS || '',
            unit,
            mint: mintUrl,
            limits: {
                max_balance:                  parseInt(process.env.MAX_BALANCE || '100000'),
                max_send:                     parseInt(process.env.MAX_SEND || '50000'),
                max_pay:                      parseInt(process.env.MAX_PAY || '50000'),
                rate_limit_max:               parseInt(process.env.RATE_LIMIT_MAX || '100'),
                rate_limit_create_wallet_max: parseInt(process.env.RATE_LIMIT_CREATE_WALLET_MAX || '3'),
                rate_limit_window:            process.env.RATE_LIMIT_WINDOW || '1 minute',
            },
        }

        log.info('GET /v1/info', { reqId: req.id })
        return info
    })


    // POST /v1/wallet
    type CreateWalletRequest = FastifyRequest<{
        Body: {
            name?: string
            token?: string
        }
    }>

    instance.post('/wallet', {
        schema: {
            description: 'Create a new short-lived wallet. Optionally provide a name for identification and an initial Cashu token to fund it immediately.',
            tags: ['Wallet'],
            body: {
                type: 'object',
                properties: {
                    name:  { type: 'string', description: 'Optional label for the wallet' },
                    token: { type: 'string', description: 'Optional Cashu token (cashuB...) to deposit on creation' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        name:            { type: 'string' },
                        access_key:      { type: 'string', description: 'Bearer token for all subsequent authenticated requests' },
                        mint:            { type: 'string' },
                        unit:            { type: 'string' },
                        balance:         { type: 'integer' },
                        pending_balance: { type: 'integer' },
                    },
                },
            },
        },
        config: {
            rateLimit: {
                max: parseInt(process.env.RATE_LIMIT_CREATE_WALLET_MAX || '3'),
                timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
            },
        },
    }, async (req: CreateWalletRequest, res: FastifyReply) => {
        const { name, token } = req.body || {}
        const mintUrl = process.env.MINT_URL || ''
        const unit = process.env.UNIT || 'sat'

        const accessKey = crypto.randomBytes(32).toString('hex')

        const wallet = await prisma.wallet.create({
            data: {
                accessKey,
                name: name || null,
                mint: mintUrl,
                unit,
            },
        })

        let balance = 0
        let pendingBalance = 0

        // If a token was provided, receive it immediately
        if (token) {
            try {
                const newProofs = await WalletService.receiveToken(wallet.id, token)
                const amount = WalletService.getProofsAmount(newProofs)
                const maxBalance = parseInt(process.env.MAX_BALANCE || '100000')

                if (amount > maxBalance) {
                    // Clean up: delete proofs and wallet
                    await prisma.proof.deleteMany({ where: { walletId: wallet.id } })
                    await prisma.wallet.delete({ where: { id: wallet.id } })
                    throw new AppError(400, Err.LIMIT_ERROR, `Token amount ${amount} exceeds max balance ${maxBalance}`, { caller: 'CreateWallet' })
                }

                balance = amount
            } catch (e: any) {
                if (e instanceof AppError) throw e
                // Clean up wallet on receive failure
                await prisma.wallet.delete({ where: { id: wallet.id } })
                throw new AppError(400, Err.VALIDATION_ERROR, `Failed to receive initial token: ${e.message}`, { caller: 'CreateWallet' })
            }
        }

        log.info('POST /v1/wallet', { walletId: wallet.id, name, hasToken: !!token, reqId: req.id })

        return {
            name: wallet.name || '',
            access_key: wallet.accessKey,
            mint: wallet.mint,
            unit: wallet.unit,
            balance,
            pending_balance: pendingBalance,
        }
    })

    done()
}
