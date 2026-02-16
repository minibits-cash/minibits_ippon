import 'dotenv/config'
import crypto from 'crypto'
import { FastifyRequest, FastifyPluginCallback, FastifyReply } from 'fastify'
import prisma from '../utils/prismaClient'
import { log } from '../services/logService'
import { WalletService } from '../services/walletService'
import AppError, { Err } from '../utils/AppError'

export const publicRoutes: FastifyPluginCallback = (instance, opts, done) => {

    // GET /v1/info
    instance.get('/info', async (req: FastifyRequest, res: FastifyReply) => {
        const unit = process.env.UNIT || 'sat'
        const mintUrl = process.env.MINT_URL || ''

        const info = {
            status: process.env.SERVICE_STATUS || 'operational',
            help: process.env.SERVICE_HELP || '',
            terms: process.env.SERVICE_TERMS || '',
            unit,
            mint: mintUrl,
            limits: {
                max_balance: parseInt(process.env.MAX_BALANCE || '100000'),
                max_send: parseInt(process.env.MAX_SEND || '50000'),
                max_pay: parseInt(process.env.MAX_PAY || '50000'),
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
        config: {
            rateLimit: {
                max: 3,
                timeWindow: '1 minute',
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
