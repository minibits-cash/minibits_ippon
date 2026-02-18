import 'dotenv/config'
import Fastify, { FastifyRequest, FastifyReply, FastifyInstance, FastifyError } from 'fastify'
import AppError from './utils/AppError'
import { publicRoutes } from './routes/publicRoutes'
import { protectedRoutes } from './routes/protectedRoutes'
import { Wallet as PrismaWallet } from '@prisma/client'

declare module 'fastify' {
    interface FastifyRequest {
        wallet: PrismaWallet
    }
}

export async function buildApp(): Promise<FastifyInstance> {
    const app: FastifyInstance = Fastify({
        trustProxy: true,
        logger: process.env.NODE_ENV !== 'test'
            ? { timestamp: () => `, "time":"${new Date().toISOString()}"` }
            : false,
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

    return app
}
