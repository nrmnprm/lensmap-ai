import { createHash } from 'node:crypto'

/** Great-circle distance, km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

export function fmtKm(km: number): string {
  return km < 1 ? `${Math.max(50, Math.round(km * 20) * 50)} m` : `${km.toFixed(1)} km`
}

/** A point 150–400 m away from the given one. The offset is derived from the
 * seed, not random: the same event always lands on the same spot, and the
 * marker does not jump around between requests (same idea as LensMap's
 * deterministic location jitter). */
export function jitterAround(lat: number, lng: number, seed: string): { lat: number; lng: number } {
  const h = createHash('sha256').update(seed).digest()
  const angle = (h.readUInt16BE(0) / 65535) * 2 * Math.PI
  const distKm = 0.15 + (h.readUInt16BE(2) / 65535) * 0.25
  const dLat = (distKm / 111) * Math.cos(angle)
  const dLng = (distKm / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle)
  return { lat: lat + dLat, lng: lng + dLng }
}
