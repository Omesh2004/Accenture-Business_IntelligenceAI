import { prisma } from "../prisma";
async function main() {
  const rows = await prisma.customer.findMany({
    take: 5, select: { riskSegment: true, branchCode: true, branch: { select: { region: true } } },
  });
  console.log("sample customers:", JSON.stringify(rows));
  const branches = await prisma.branch.groupBy({ by: ["region"], _count: true });
  console.log("branch regions:", JSON.stringify(branches));
  await prisma.$disconnect();
}
main();
