import { log } from './services/logService'
import { buildApp } from './app'

const app = await buildApp()

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
