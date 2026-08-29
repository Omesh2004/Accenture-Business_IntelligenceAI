import { prisma } from "../prisma";
async function main() {
  const g = await prisma.transaction.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("POSTGRES:", JSON.stringify(g));
  console.log("total pg:", await prisma.transaction.count());
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
