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

    if (!process.env.MINT_URLS) {
        log.error('Missing MINT_URLS environment variable, exiting...')
        process.exit(1)
    }

    const mintUrls = process.env.MINT_URLS.split(',').map((u: string) => u.trim()).filter((u: string) => u.length > 0)
    if (mintUrls.length === 0) {
        log.error('MINT_URLS contains no valid URLs, exiting...')
        process.exit(1)
    }

    if (!process.env.DATABASE_URL) {
        log.error('Missing DATABASE_URL environment variable, exiting...')
        process.exit(1)
    }

    log.info('Minibits Ippon started', {
        mints: mintUrls,
        unit:  process.env.UNIT || 'sat',
        port:  process.env.PORT || '3000',
    })
})
