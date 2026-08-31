import { prisma } from "../prisma";

export async function generateUniqueAccountNumber(): Promise<string> {
  let accNo = "";
  let exists = true;

  while (exists) {
    accNo = Math.floor(10 ** 12 + Math.random() * 9 * 10 ** 12).toString();

    const existingAccount = await prisma.account.findUnique({
      where: { accNo },
    });

    if (!existingAccount) {
      exists = false;
    }
  }

  return accNo;
}
