import { prisma } from "../prisma";
async function main() {
  const rows: Array<{ tag: string; n: bigint; first: Date; last: Date }> =
    await prisma.$queryRawUnsafe(`
      SELECT split_part("accNo", '-A', 1) AS tag, count(*) AS n,
             min("createdOn") AS first, max("createdOn") AS last
      FROM "Account" GROUP BY 1 ORDER BY n DESC LIMIT 12`);
  for (const r of rows) {
    console.log(`  ${r.tag.padEnd(26)} n=${String(r.n).padStart(6)}  ${r.first?.toISOString().slice(0,10)} .. ${r.last?.toISOString().slice(0,10)}`);
  }
  await prisma.$disconnect();
}
main();
