import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        env: {
            NODE_ENV: 'test',
            MINT_URL: 'https://testmint.example.com',
            UNIT: 'sat',
            MAX_BALANCE: '100000',
            MAX_SEND: '50000',
            MAX_PAY: '50000',
            RATE_LIMIT_MAX: '100',
            RATE_LIMIT_CREATE_WALLET_MAX: '3',
            RATE_LIMIT_WINDOW: '1 minute',
            SERVICE_STATUS: 'operational',
            SERVICE_HELP: 'https://example.com/help',
            SERVICE_TERMS: 'https://example.com/terms',
        },
    },
})
