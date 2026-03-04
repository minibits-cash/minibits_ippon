import 'dotenv/config'
import readline from 'readline'
import crypto from 'crypto'
import {
    MintQuoteState,
    getDecodedToken,
    getEncodedTokenV4,
    decodePaymentRequest,
} from '@cashu/cashu-ts'
import { decode as bolt11Decode } from '@gandlaf21/bolt11-decode'
import prisma from './utils/prismaClient'
import { WalletService } from './services/walletService'
import { NostrService } from './services/nostrService'
import { log } from './services/logService'

// ── Key helpers ───────────────────────────────────────────────────────────────

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function generateShortKey(): string {
    const bytes = crypto.randomBytes(6)
    return Array.from(bytes, b => KEY_CHARS[b % KEY_CHARS.length]).join('')
}

// Display short (6-char) keys as xxx-xxx; leave full hex keys as-is.
function formatKey(key: string): string {
    return key.length === 6 ? `${key.slice(0, 3)}-${key.slice(3)}` : key
}

// Accept keys with or without the visual dash.
function normalizeKey(input: string): string {
    return input.replace(/-/g, '').toLowerCase()
}

// ── Output helpers ────────────────────────────────────────────────────────────

// All structured responses are JSON lines on stdout so callers can parse them.
function out(obj: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(obj) + '\n')
}

function cliError(message: string, code = 'ERROR'): void {
    process.stdout.write(JSON.stringify({ error: true, code, message }) + '\n')
}

// ── Command handler ───────────────────────────────────────────────────────────

async function handleCommand(parts: string[]): Promise<void> {
    const cmd = parts[0]?.toLowerCase()

    // help ────────────────────────────────────────────────────────────────────
    if (!cmd || cmd === 'help') {
        out({
            commands: [
                'info',
                'wallet create [name] [mint_url]',
                'wallet list',
                'wallet <key> balance',
                'wallet <key> deposit <amount>',
                'wallet <key> deposit-check <quote_id>',
                'wallet <key> send <amount> [lock_pubkey]',
                'wallet <key> receive <token>',
                'wallet <key> pay <bolt11_or_lightning_address> [amount_sats]',
                'wallet <key> pay-check <quote_id>',
                'wallet <key> sync',
                'decode <cashu_token_or_bolt11_or_cashu_request>',
                'help',
                'exit',
            ],
        })
        return
    }

    // info ────────────────────────────────────────────────────────────────────
    if (cmd === 'info') {
        out({
            unit:  process.env.UNIT || 'sat',
            mints: WalletService.getMintUrls(),
            limits: {
                max_balance: parseInt(process.env.MAX_BALANCE || '100000'),
                max_send:    parseInt(process.env.MAX_SEND    || '50000'),
                max_pay:     parseInt(process.env.MAX_PAY     || '50000'),
            },
        })
        return
    }

    // decode ──────────────────────────────────────────────────────────────────
    if (cmd === 'decode') {
        const data = parts[1]
        if (!data) { cliError('Usage: decode <data>'); return }
        try {
            if (data.startsWith('cashu')) {
                out({ type: 'CASHU_TOKEN', decoded: getDecodedToken(data) })
            } else if (data.startsWith('creq')) {
                out({ type: 'CASHU_REQUEST', decoded: decodePaymentRequest(data) })
            } else {
                out({ type: 'BOLT11', decoded: bolt11Decode(data) })
            }
        } catch (e: any) {
            cliError(e.message, 'DECODE_ERROR')
        }
        return
    }

    // wallet ──────────────────────────────────────────────────────────────────
    if (cmd === 'wallet') {
        const sub = parts[1]

        // wallet create [name] [mint_url]
        // mint_url is detected by http/https prefix; it can appear as parts[2] or parts[3]
        if (sub === 'create') {
            try {
                const unit = process.env.UNIT || 'sat'
                const mintUrls = WalletService.getMintUrls()
                if (mintUrls.length === 0) { cliError('No MINT_URLS configured'); return }

                let name: string | null = null
                let mint = mintUrls[0]

                if (parts[2]?.startsWith('http')) {
                    // wallet create <mint_url>
                    mint = parts[2]
                } else if (parts[2]) {
                    // wallet create <name> [mint_url]
                    name = parts[2]
                    if (parts[3]?.startsWith('http')) mint = parts[3]
                }

                if (!mintUrls.includes(mint)) {
                    cliError(`Mint '${mint}' is not in the configured MINT_URLS`, 'VALIDATION_ERROR')
                    return
                }

                const accessKey = generateShortKey()
                const wallet = await prisma.wallet.create({
                    data: { accessKey, name, mint, unit },
                })
                out({
                    access_key:      formatKey(wallet.accessKey),
                    name:            wallet.name || '',
                    mint:            wallet.mint,
                    unit:            wallet.unit,
                    balance:         0,
                    pending_balance: 0,
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // wallet list
        if (sub === 'list') {
            try {
                const wallets = await prisma.wallet.findMany({ orderBy: { id: 'asc' } })
                const rows = await Promise.all(wallets.map(async w => {
                    const { balance, pendingBalance } = await WalletService.getWalletBalance(w.id)
                    return {
                        access_key:      formatKey(w.accessKey),
                        name:            w.name || '',
                        mint:            w.mint,
                        unit:            w.unit,
                        balance,
                        pending_balance: pendingBalance,
                    }
                }))
                out({ wallets: rows })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // wallet <access_key> <operation> [args...]
        const rawKey = sub
        const op = parts[2]?.toLowerCase()

        if (!rawKey || !op) {
            cliError('Usage: wallet <access_key> <operation>  |  wallet create [name]  |  wallet list')
            return
        }

        const accessKey = normalizeKey(rawKey)
        const wallet = await prisma.wallet.findUnique({ where: { accessKey } })
        if (!wallet) { cliError('Wallet not found', 'NOT_FOUND'); return }

        // balance
        if (op === 'balance') {
            try {
                const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)
                out({
                    access_key:      formatKey(wallet.accessKey),
                    name:            wallet.name || '',
                    mint:            wallet.mint,
                    unit:            wallet.unit,
                    balance,
                    pending_balance: pendingBalance,
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // deposit <amount>
        if (op === 'deposit') {
            const amount = parseInt(parts[3])
            if (!amount || amount <= 0) { cliError('Usage: wallet <key> deposit <amount>'); return }
            try {
                const quote = await WalletService.createMintQuote(amount, wallet.mint)
                out({ quote: quote.quote, request: quote.request, state: quote.state, expiry: quote.expiry })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // deposit-check <quote_id>
        if (op === 'deposit-check') {
            const quoteId = parts[3]
            if (!quoteId) { cliError('Usage: wallet <key> deposit-check <quote_id>'); return }
            try {
                const quote = await WalletService.checkMintQuote(quoteId, wallet.mint)
                if (quote.state === MintQuoteState.PAID) {
                    try {
                        const proofs = await WalletService.mintProofs(quote.amount, quote.quote, wallet.mint)
                        await WalletService.saveProofs(wallet.id, proofs)
                    } catch (e: any) {
                        log.warn('[CLI deposit-check] mint proofs failed', { error: e.message })
                    }
                }
                out({ quote: quote.quote, request: quote.request, state: quote.state, expiry: quote.expiry })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // send <amount> [lock_pubkey]
        if (op === 'send') {
            const amount = parseInt(parts[3])
            if (!amount || amount <= 0) { cliError('Usage: wallet <key> send <amount> [lock_pubkey]'); return }
            try {
                let p2pkPubkey: string | undefined
                if (parts[4]) p2pkPubkey = NostrService.normalizePubkey(parts[4])
                const { send } = await WalletService.sendProofs(wallet.id, amount, wallet.mint, p2pkPubkey)
                const token = getEncodedTokenV4({ mint: wallet.mint, proofs: send, unit: wallet.unit })
                out({ token, amount: WalletService.getProofsAmount(send), unit: wallet.unit })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // receive <token>
        if (op === 'receive') {
            const tokenStr = parts[3]
            if (!tokenStr) { cliError('Usage: wallet <key> receive <token>'); return }
            try {
                const newProofs = await WalletService.receiveToken(wallet.id, tokenStr, wallet.mint)
                const amount = WalletService.getProofsAmount(newProofs)
                const { balance, pendingBalance } = await WalletService.getWalletBalance(wallet.id)
                out({ amount, unit: wallet.unit, balance, pending_balance: pendingBalance })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // pay <bolt11_or_lnaddress> [amount_sats]
        if (op === 'pay') {
            const target = parts[3]
            if (!target) { cliError('Usage: wallet <key> pay <bolt11_or_lightning_address> [amount_sats]'); return }
            const amount = parseInt(parts[4]) || 0
            try {
                let invoice = target
                if (target.includes('@') && !target.toLowerCase().startsWith('lnbc')) {
                    const [name, domain] = target.split('@')
                    const lnurlRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`)
                    const lnurlData = await lnurlRes.json() as any
                    if (lnurlData.status === 'ERROR') throw new Error(lnurlData.reason || 'LNURL error')
                    const callbackUrl = new URL(lnurlData.callback)
                    callbackUrl.searchParams.set('amount', String(amount * 1000))
                    const invRes = await fetch(callbackUrl.toString())
                    const invData = await invRes.json() as any
                    if (invData.status === 'ERROR') throw new Error(invData.reason || 'Invoice fetch failed')
                    invoice = invData.pr
                }
                const meltQuote = await WalletService.createMeltQuote(invoice, wallet.mint)
                const meltResponse = await WalletService.meltProofs(wallet.id, meltQuote, wallet.mint)
                out({
                    quote:            meltResponse.quote.quote,
                    amount:           meltResponse.quote.amount,
                    fee_reserve:      meltResponse.quote.fee_reserve,
                    state:            meltResponse.quote.state,
                    payment_preimage: meltResponse.quote.payment_preimage,
                    expiry:           meltResponse.quote.expiry,
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // pay-check <quote_id>
        if (op === 'pay-check') {
            const quoteId = parts[3]
            if (!quoteId) { cliError('Usage: wallet <key> pay-check <quote_id>'); return }
            try {
                const quote = await WalletService.checkMeltQuote(quoteId, wallet.mint)
                out({
                    quote:            quote.quote,
                    amount:           quote.amount,
                    fee_reserve:      quote.fee_reserve,
                    state:            quote.state,
                    payment_preimage: quote.payment_preimage,
                    expiry:           quote.expiry,
                })
            } catch (e: any) { cliError(e.message) }
            return
        }

        // sync
        if (op === 'sync') {
            try {
                const result = await WalletService.syncProofsStateWithMint(wallet.id, wallet.mint)
                out(result as unknown as Record<string, unknown>)
            } catch (e: any) { cliError(e.message) }
            return
        }

        cliError(`Unknown wallet operation: ${op}. Type 'help' for available commands.`)
        return
    }

    cliError(`Unknown command: ${cmd}. Type 'help' for available commands.`)
}

// ── REPL entry point ──────────────────────────────────────────────────────────

// Returns a Promise that resolves only after readline is fully closed and any
// in-flight command has finished — safe for both interactive and piped use.
export function startCli(): Promise<void> {
    return new Promise<void>((resolve) => {
        const rl = readline.createInterface({
            input:  process.stdin,
            output: process.stdout,
            prompt: '> ',
        })

        process.stderr.write('Minibits Ippon CLI — type "help" for commands, "exit" to quit\n')
        rl.prompt()

        // Track the in-flight async handler so the 'close' handler can await it.
        let currentOp: Promise<void> | null = null

        rl.on('line', (line: string) => {
            const trimmed = line.trim()
            if (!trimmed) { rl.prompt(); return }

            if (trimmed === 'exit' || trimmed === 'quit') {
                process.stderr.write('Bye!\n')
                rl.close()
                return
            }

            const parts = trimmed.split(/\s+/)
            currentOp = (async () => {
                try {
                    await handleCommand(parts)
                } catch (e: any) {
                    cliError(e.message)
                }
                rl.prompt()
            })()
        })

        rl.on('close', () => {
            // Await the in-flight operation (if any) before disconnecting.
            const cleanup = async () => {
                if (currentOp) await currentOp
                await prisma.$disconnect()
                resolve()
            }
            cleanup()
        })
    })
}
