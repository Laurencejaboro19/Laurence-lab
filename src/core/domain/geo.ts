/**
 * Zone membership without PostGIS: a ray-casting point-in-polygon test over
 * GeoJSON polygons (outer ring + optional holes). Good enough for delivery
 * zones drawn as a few dozen vertices; runs in microseconds.
 */
import type { GeoPoint } from '../channel/types.js';

/** GeoJSON Polygon geometry: rings of [longitude, latitude]. */
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface Zone {
  id: string;
  name: string;
  polygon: GeoJsonPolygon;
}

function inRing(point: GeoPoint, ring: [number, number][]): boolean {
  const x = point.longitude;
  const y = point.latitude;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point: GeoPoint, polygon: GeoJsonPolygon): boolean {
  const [outer, ...holes] = polygon.coordinates;
  if (!outer || outer.length < 3) return false;
  if (!inRing(point, outer)) return false;
  return !holes.some((hole) => inRing(point, hole));
}

/** First zone (in the given order) that contains the point, or undefined. */
export function findZone<Z extends Zone>(point: GeoPoint, zones: readonly Z[]): Z | undefined {
  return zones.find((z) => pointInPolygon(point, z.polygon));
}

/** Haversine distance in metres, for ETA hints and sanity checks on pins. */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function isValidPoint(p: GeoPoint): boolean {
  return (
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}
