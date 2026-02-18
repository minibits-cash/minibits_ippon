import { decode } from 'nostr-tools/nip19'
import AppError, { Err } from '../utils/AppError'

/**
 * Normalizes a public key to a compressed SEC1 hex string (66 chars, 33 bytes).
 * Accepts:
 *   - npub1... bech32 encoded key → converted to 02-prefixed 33-byte hex
 *   - 64-char hex (raw 32-byte x-only key) → prepended with '02'
 *   - 66-char hex (already compressed) → returned as-is
 */
const normalizePubkey = function (pubkey: string): string {
    if (pubkey.startsWith('npub')) {
        try {
            const decoded = decode(pubkey)
            if (decoded.type !== 'npub') {
                throw new AppError(400, Err.VALIDATION_ERROR, 'Invalid npub key')
            }
            return '02' + decoded.data
        } catch (e: any) {
            if (e instanceof AppError) throw e
            throw new AppError(400, Err.VALIDATION_ERROR, `Failed to decode npub key: ${e.message}`)
        }
    }

    if (pubkey.length === 64) {
        // Raw 32-byte x-only hex key
        return '02' + pubkey
    }

    if (pubkey.length === 66) {
        // Already compressed SEC1 hex (02... or 03...)
        return pubkey
    }

    throw new AppError(400, Err.VALIDATION_ERROR, 'Invalid pubkey: provide a compressed hex (66 chars), x-only hex (64 chars), or npub1... encoded key')
}

export const NostrService = {
    normalizePubkey,
}
