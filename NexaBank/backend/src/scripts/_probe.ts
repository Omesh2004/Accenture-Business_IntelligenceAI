import { prisma } from "../prisma";
async function main() {
  const wm = new Date("2026-08-28T11:24:30Z");
  const byStatus = await prisma.transaction.groupBy({ by: ["status"], _count: true });
  const mutated = await prisma.transaction.count({ where: { status: { in: ["PENDING","REVERSED"] } } });
  const mutatedAfterWm = await prisma.transaction.count({ where: { status: { in: ["PENDING","REVERSED"] }, timestamp: { gt: wm } } });
  const anyAfterWm = await prisma.transaction.count({ where: { timestamp: { gt: wm } } });
  const maxTs = await prisma.transaction.aggregate({ _max: { timestamp: true } });
  console.log(JSON.stringify({ byStatus, mutated, mutatedAfterWm, anyAfterWm, maxTs }, null, 1));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
