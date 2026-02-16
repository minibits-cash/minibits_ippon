import { FastifyRequest, FastifyReply } from 'fastify'
import prisma from '../utils/prismaClient'
import { log } from '../services/logService'
import AppError, { Err } from '../utils/AppError'

export const bearerAuthHandler = async (req: FastifyRequest<any>, reply: FastifyReply): Promise<void> => {
    const authHeader = req.headers.authorization

    if (!authHeader) {
        throw new AppError(401, Err.UNAUTHORIZED_ERROR, 'Missing Authorization header', {
            caller: 'bearerAuthHandler'
        })
    }

    if (!authHeader.startsWith('Bearer ')) {
        throw new AppError(401, Err.UNAUTHORIZED_ERROR, 'Invalid Authorization header format', {
            caller: 'bearerAuthHandler'
        })
    }

    const accessKey = authHeader.substring(7)

    if (!accessKey) {
        throw new AppError(401, Err.UNAUTHORIZED_ERROR, 'Empty access key', {
            caller: 'bearerAuthHandler'
        })
    }

    const wallet = await prisma.wallet.findUnique({
        where: { accessKey },
    })

    if (!wallet) {
        throw new AppError(401, Err.UNAUTHORIZED_ERROR, 'Invalid access key', {
            caller: 'bearerAuthHandler'
        })
    }

    // Attach wallet to request for downstream handlers
    ;(req as any).wallet = wallet

    log.trace('[bearerAuthHandler] Authenticated wallet', {
        walletId: wallet.id,
        name: wallet.name,
        url: req.url,
    })
}
