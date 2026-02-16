import { log } from "./logService"

const SATOSHIS_PER_BTC = 100_000_000
const RATE_FETCH_TIMEOUT_MS = 5000
const RATE_CACHE_TTL_MS = 120_000 // 2 minutes

export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'cad', 'gbp'] as const
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number]

const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3/simple/price'

interface RateResponse {
    currency: string
    rate: number
    timestamp: number
}

interface RateCache {
    [currency: string]: RateResponse
}

const rateCache: RateCache = {}

let inFlightRateRequest: Promise<Record<string, number>> | null = null

async function fetchRatesFromCoinGecko(): Promise<Record<string, number>> {
    const controller = new AbortController()

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
            controller.abort()
            reject(new Error('Timeout'))
        }, RATE_FETCH_TIMEOUT_MS)
    })

    const currencies = SUPPORTED_CURRENCIES.join(',')
    const url = `${COINGECKO_API_URL}?ids=bitcoin&vs_currencies=${currencies}`

    const fetchPromise = fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
    })
        .then(response => {
            if (!response.ok) {
                throw new Error(`CoinGecko API returned ${response.status}`)
            }
            return response.json()
        })
        .then(data => {
            if (!data?.bitcoin) {
                throw new Error('Invalid response from CoinGecko')
            }
            return data.bitcoin as Record<string, number>
        })

    return Promise.race([fetchPromise, timeoutPromise])
}

export async function getExchangeRate(currency: string, reqId?: string): Promise<RateResponse> {
    const currencyLower = currency.toLowerCase()
    const currencyUpper = currency.toUpperCase()
    const now = Date.now()
    const cache = rateCache[currencyLower]

    if (cache && now - cache.timestamp < RATE_CACHE_TTL_MS) {
        log.info('ExchangeRateService', 'Returning cached rate', { rateResponse: cache, reqId })
        return cache
    }

    if (!SUPPORTED_CURRENCIES.includes(currencyLower as SupportedCurrency)) {
        throw new Error(`Unsupported currency: ${currency}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`)
    }

    try {
        let rates: Record<string, number>

        if (inFlightRateRequest) {
            log.info('ExchangeRateService', 'Waiting for in-flight request', { reqId })
            rates = await inFlightRateRequest
        } else {
            inFlightRateRequest = fetchRatesFromCoinGecko()
                .finally(() => {
                    inFlightRateRequest = null
                })
            rates = await inFlightRateRequest
        }

        const rateInFiat = rates[currencyLower]

        if (!rateInFiat || isNaN(rateInFiat)) {
            throw new Error(`No rate available for currency: ${currency}`)
        }

        const rateInSats = SATOSHIS_PER_BTC / rateInFiat
        const rateResponse: RateResponse = {
            currency: currencyUpper,
            rate: rateInSats,
            timestamp: now
        }

        for (const [cur, rate] of Object.entries(rates)) {
            if (rate && !isNaN(rate)) {
                rateCache[cur] = {
                    currency: cur.toUpperCase(),
                    rate: SATOSHIS_PER_BTC / rate,
                    timestamp: now
                }
            }
        }

        log.info('ExchangeRateService', 'Fetched fresh rate from CoinGecko', { rateResponse, reqId })

        return rateResponse
    } catch (e: any) {
        const isTimeout = e.message === 'Timeout'
        const errorType = isTimeout ? 'Timeout' : 'API error'

        if (cache) {
            log.warn('ExchangeRateService', `${errorType}, returning stale cache: ${e.message}`, { cache, reqId })
            return cache
        }

        throw new Error(`Failed to fetch exchange rate (${errorType}): ${e.message}`)
    }
}

export function isSupportedCurrency(currency: string): boolean {
    return SUPPORTED_CURRENCIES.includes(currency.toLowerCase() as SupportedCurrency)
}
