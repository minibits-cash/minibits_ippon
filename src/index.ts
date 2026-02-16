import 'dotenv/config'
import Fastify, { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify'
import { log } from './services/logService'
import AppError from './utils/AppError'
import { publicRoutes } from './routes/publicRoutes'
import { protectedRoutes } from './routes/protectedRoutes'
import { Wallet as PrismaWallet } from '@prisma/client'

declare module 'fastify' {
    interface FastifyRequest {
        wallet: PrismaWallet
    }
}

const app: FastifyInstance = Fastify({
    trustProxy: true,
    logger: {
        timestamp: () => `, "time":"${new Date().toISOString()}"`
    }
})

app.setErrorHandler(function (err: FastifyError | AppError, req: FastifyRequest, res: FastifyReply) {
    if (err instanceof AppError) {
        const { statusCode, name, message, params } = err
        res.code(statusCode).send({ error: { statusCode, name, message, params } })
    } else {
        const { statusCode, name, message } = err
        res.code(statusCode || 500).send({ error: { statusCode, name, message } })
    }
})

await app.register(import('@fastify/rate-limit'), {
    global: false,
    max: 100,
    timeWindow: '1 minute',
})

app.register(publicRoutes, { prefix: '/v1' })
app.register(protectedRoutes, { prefix: '/v1' })

app.listen({
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '3000'),
    listenTextResolver: (address) => { return `Minibits Ippon ready at: ${address}` }
}, (err: any) => {
    if (err) {
        console.error(err)
        process.exit(1)
    }

    if (!process.env.MINT_URL) {
        log.error('Missing MINT_URL environment variable, exiting...')
        process.exit(1)
    }

    if (!process.env.DATABASE_URL) {
        log.error('Missing DATABASE_URL environment variable, exiting...')
        process.exit(1)
    }

    log.info('Minibits Ippon started', {
        mint: process.env.MINT_URL,
        unit: process.env.UNIT || 'sat',
        port: process.env.PORT || '3000',
    })
})
