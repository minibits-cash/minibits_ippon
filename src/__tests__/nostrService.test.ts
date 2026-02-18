import { describe, it, expect, vi } from 'vitest'
import { npubEncode } from 'nostr-tools/nip19'

vi.mock('../services/logService', () => ({
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Import after mocks are set up
const { NostrService } = await import('../services/nostrService')

const HEX64 = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const HEX66_02 = '02' + HEX64
const HEX66_03 = '03' + HEX64

describe('NostrService.normalizePubkey', () => {
    describe('66-char compressed hex', () => {
        it('returns 02-prefixed key unchanged', () => {
            expect(NostrService.normalizePubkey(HEX66_02)).toBe(HEX66_02)
        })

        it('returns 03-prefixed key unchanged', () => {
            expect(NostrService.normalizePubkey(HEX66_03)).toBe(HEX66_03)
        })
    })

    describe('64-char x-only hex', () => {
        it('prepends 02 prefix', () => {
            expect(NostrService.normalizePubkey(HEX64)).toBe(HEX66_02)
        })
    })

    describe('npub bech32', () => {
        it('decodes npub and prepends 02', () => {
            const npub = npubEncode(HEX64)
            expect(NostrService.normalizePubkey(npub)).toBe(HEX66_02)
        })

        it('throws AppError on malformed npub', () => {
            expect(() => NostrService.normalizePubkey('npub1aaabbbccc')).toThrow()
        })
    })

    describe('invalid inputs', () => {
        it('throws AppError on too-short hex', () => {
            expect(() => NostrService.normalizePubkey('abcd1234')).toThrow()
        })

        it('throws AppError on 65-char hex', () => {
            expect(() => NostrService.normalizePubkey('a'.repeat(65))).toThrow()
        })

        it('throws AppError on empty string', () => {
            expect(() => NostrService.normalizePubkey('')).toThrow()
        })
    })
})
