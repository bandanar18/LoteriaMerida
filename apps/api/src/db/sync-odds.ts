import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { OddsFeedService } from '../sports/odds-feed.service';

/** Sincroniza ahora las cuotas de The Odds API (gasta créditos del plan). Uso: npm run odds:sync */
async function main() {
  const db = new DbService();
  const feed = new OddsFeedService(db, new AuditService());
  try {
    if (!feed.enabled) throw new Error('Falta ODDS_API_KEY en apps/api/.env');
    await feed.sync('MANUAL');
    console.log(JSON.stringify((await feed.status()).lastRun, null, 2));
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
