/**
 * SELECT de eventos con sus mercados y selecciones anidados. `marketFilter` limita qué mercados
 * se muestran (al público solo abiertos/suspendidos); `withExposure` añade el pasivo por selección (backoffice).
 */
export function eventsSql(opts: { where: string; marketFilter: string; admin?: boolean; order?: string; limit?: number }) {
  const exposure = opts.admin
    ? `, 'exposure', (SELECT coalesce(jsonb_object_agg(x.currency, jsonb_build_object('liability', x.liability::text, 'stake', x.stake::text)), '{}')
                       FROM sports.exposure x WHERE x.selection_id = s.id),
         'bets', (SELECT count(*) FROM sports.bet_leg l WHERE l.selection_id = s.id)`
    : '';
  const adminCols = opts.admin
    ? `e.proposed_home, e.proposed_away, e.proposed_evidence, e.proposed_by, pb.email AS proposed_by_email,`
    : '';
  return `
    SELECT e.id, e.starts_at, e.status, e.home_score, e.away_score, e.result_status, e.cancelled_reason, e.confirmed_at,
           ${adminCols} c.id AS competition_id, c.name AS competition, c.country, c.sport_code AS sport,
           h.name AS home, a.name AS away, now() AS server_now,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', m.id, 'type', m.type_code, 'line', m.line::text, 'status', m.status, 'void_reason', m.void_reason,
                      'selections', (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name,
                                                                         'odds', s.odds::text, 'result', s.result${exposure})
                                                      ORDER BY s.sort)
                                       FROM sports.selection s WHERE s.market_id = m.id))
                    ORDER BY m.created_at, m.line NULLS FIRST)
               FROM sports.market m WHERE m.event_id = e.id AND ${opts.marketFilter}), '[]') AS markets
      FROM sports.event e
      JOIN sports.competition c ON c.id = e.competition_id
      JOIN sports.participant h ON h.id = e.home_id
      JOIN sports.participant a ON a.id = e.away_id
      LEFT JOIN identity.app_user pb ON pb.id = e.proposed_by
     WHERE ${opts.where}
     ORDER BY ${opts.order ?? 'e.status = \'LIVE\' DESC, e.starts_at, c.sort'}
     ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`;
}
