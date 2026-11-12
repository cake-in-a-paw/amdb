// Pure placement of Wikidata seasons and episodes under their show. No I/O; the parts importer acts on it.
import type { Claim, WikidataEntity } from './client.js';
import { entityId, MAX_POSITION, valueSnaks } from './map.js';

/** Non-deprecated value claims on `property`, `preferred` rank first, otherwise in Wikidata's order. */
function rankedClaims(entity: WikidataEntity, property: string): Claim[] {
  const claims = valueSnaks(entity, property).map(({ claim }) => claim);
  return [...claims.filter((c) => c.rank === 'preferred'), ...claims.filter((c) => c.rank !== 'preferred')];
}

/** The first whole-number `P1545` value that fits a Postgres integer, 0 included; otherwise null. */
export function ordinal(claim: Claim): number | null {
  for (const q of claim.qualifiers?.P1545 ?? []) {
    const v = q.snaktype === 'value' ? q.datavalue?.value : undefined;
    if (typeof v !== 'string' || !/^\d+$/.test(v)) continue;
    const n = Number(v);
    if (n <= MAX_POSITION) return n;
  }
  return null;
}

/** The entity's non-deprecated claim on `property` whose value is `targetQid`, `preferred` rank first. */
export function claimTo(entity: WikidataEntity, property: string, targetQid: string): Claim | null {
  return rankedClaims(entity, property).find((c) => entityId(c.mainsnak) === targetQid) ?? null;
}

/** The first non-deprecated value claim on `property`, `preferred` rank first. */
export function firstValueClaim(entity: WikidataEntity, property: string): Claim | null {
  return rankedClaims(entity, property)[0] ?? null;
}

/** Whether the claim has any `P1545` qualifier, whatever its value. */
export function hasP1545(claim: Claim): boolean {
  return (claim.qualifiers?.P1545 ?? []).length > 0;
}

/** Whether the parent's `P527` (has part) lists the child, and at what position. */
export function listedPosition(
  parent: WikidataEntity | undefined,
  childQid: string,
): { listed: boolean; position: number | null } {
  const c = parent ? claimTo(parent, 'P527', childQid) : null;
  return { listed: c !== null, position: c ? ordinal(c) : null };
}

/**
 * The season's own `P179` ordinal when it has one (even a non-whole one, which gives null);
 * only without it is the show's `P527` list read.
 */
export function seasonNumber(season: WikidataEntity, showQid: string, show: WikidataEntity | undefined): number | null {
  const own = claimTo(season, 'P179', showQid);
  if (own && hasP1545(own)) return ordinal(own);
  return listedPosition(show, season.id).position;
}

export interface Placement {
  placed: { qid: string; parentQid: string; position: number | null }[];
  unplaced: string[];
}

/**
 * Where each episode hangs, in the spec's order; it never guesses, so anything else is unplaced:
 * 1. its `P4908` season, when that season is placed under this show;
 * 2. else the one placed season whose `P527` lists it;
 * 3. else directly under the show, by its overall number, when the show has no seasons at all.
 * A `P4908` season outside `seasonsOfShow` counts as another show's.
 */
export function placeEpisodes(input: {
  showQid: string;
  show?: WikidataEntity;
  /** The show's seasons only, as `discoverParts`' season query returned them. */
  seasonsOfShow: Map<string, WikidataEntity>;
  /** Season QIDs imported now or already in AMDB under this show. */
  placedSeasons: Set<string>;
  /** AMDB already holds a season under the show. */
  showHasSeasonParts: boolean;
  episodes: WikidataEntity[];
}): Placement {
  const { showQid, seasonsOfShow, placedSeasons, showHasSeasonParts, episodes } = input;
  const out: Placement = { placed: [], unplaced: [] };
  const place = (e: WikidataEntity, parentQid: string, position: number | null) =>
    out.placed.push({ qid: e.id, parentQid, position });

  for (const e of episodes) {
    const own = firstValueClaim(e, 'P4908');
    const q = own ? entityId(own.mainsnak) : null;
    if (own && q && placedSeasons.has(q)) {
      place(e, q, hasP1545(own) ? ordinal(own) : listedPosition(seasonsOfShow.get(q), e.id).position);
      continue;
    }
    if (q && !seasonsOfShow.has(q)) {
      out.unplaced.push(e.id);
      continue;
    }
    const listing = [...placedSeasons].filter((s) => listedPosition(seasonsOfShow.get(s), e.id).listed);
    const [only] = listing;
    if (listing.length === 1 && only !== undefined) {
      place(e, only, listedPosition(seasonsOfShow.get(only), e.id).position);
      continue;
    }
    if (listing.length === 0 && seasonsOfShow.size === 0 && !showHasSeasonParts) {
      const c = claimTo(e, 'P179', showQid);
      place(e, showQid, c ? ordinal(c) : null);
      continue;
    }
    out.unplaced.push(e.id);
  }
  return out;
}
