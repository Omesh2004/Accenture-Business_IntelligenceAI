const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function generateUniqueAccountNumber() {
  let accNo;
  let exists = true;

    while (exists) {
        accNo = Math.floor(10 ** 12 + Math.random() * 9 * 10 ** 12).toString(); // 12-digit number

        // Check if the number already exists
        const existingAccount = await prisma.account.findUnique({
            where: { accNo },
        });

        if (!existingAccount) {
            exists = false;
        }
    }

    return accNo;
}

async function main() {
  const customers = [
    {
      name: "John Doe",
      email: "john.doe@example.com",
      phone: "1234567890",
      password: await bcrypt.hash("password123", 10),
      address: {
        street: "123 Main St",
        city: "Anytown",
        state: "CA",
        zip: "12345",
      },

      customerType: "INDIVIDUAL",
      dateOfBirth: new Date("1990-01-01"),
      pan: "ABCDE1234F",
      settingConfig: { theme: "dark" },
    },
    {
      name: "Jane Smith",
      email: "jane.smith@example.com",
      phone: "0987654321",
      password: await bcrypt.hash("password456", 10),
      address: {
        street: "456 Elm St",
        city: "Othertown",
        state: "NY",
        zip: "67890",
      },
      customerType: "INDIVIDUAL",
      dateOfBirth: new Date("1985-05-15"),
      pan: "XYZAB5678C",
      settingConfig: { theme: "light" },
    },
    {
      name: "Alice Johnson",
      email: "alice.johnson@example.com",
      phone: "1112223333",
      password: await bcrypt.hash("password789", 10),
      address: {
        street: "789 Oak St",
        city: "Sometown",
        state: "TX",
        zip: "54321",
      },
      customerType: "INDIVIDUAL",
      dateOfBirth: new Date("1992-03-10"),
      pan: "LMNOP1234Q",
      settingConfig: { theme: "dark" },
    },
    {
      name: "Bob Brown",
      email: "bob.brown@example.com",
      phone: "4445556666",
      password: await bcrypt.hash("password101", 10),
      address: {
        street: "101 Pine St",
        city: "Anycity",
        state: "FL",
        zip: "67890",
      },

      customerType: "INDIVIDUAL",
      dateOfBirth: new Date("1988-07-22"),
      pan: "QRSTU5678V",
      settingConfig: { theme: "light" },
    },
    {
      name: "Charlie Davis",
      email: "charlie.davis@example.com",
      phone: "7778889999",
      password: await bcrypt.hash("password202", 10),
      address: {
        street: "202 Birch St",
        city: "Anyville",
        state: "WA",
        zip: "12345",
      },

      customerType: "INDIVIDUAL",
      dateOfBirth: new Date("1995-11-30"),
      pan: "WXYZ1234A",
      settingConfig: { theme: "dark" },
    },
    {
      name: "Tech Corp",
      email: "contact@techcorp.com",
      phone: "2223334444",
      password: await bcrypt.hash("password303", 10),
      address: {
        street: "303 Cedar St",
        city: "Techcity",
        state: "CA",
        zip: "98765",
      },

      customerType: "OTHERS",
      dateOfBirth: new Date("2000-01-01"),
      pan: "COMP1234B",
      settingConfig: { theme: "light" },
    },
    {
      name: "Biz Solutions",
      email: "info@bizsolutions.com",
      phone: "5556667777",
      password: await bcrypt.hash("password404", 10),
      address: {
        street: "404 Maple St",
        city: "Biztown",
        state: "NY",
        zip: "87654",
      },
      customerType: "OTHERS",
      dateOfBirth: new Date("2005-05-05"),
      pan: "COMP5678C",
      settingConfig: { theme: "dark" },
    },
    {
      name: "Enterprise Inc",
      email: "support@enterpriseinc.com",
      phone: "8889990000",
      password: await bcrypt.hash("password505", 10),
      address: {
        street: "505 Spruce St",
        city: "Entercity",
        state: "TX",
        zip: "76543",
      },

      customerType: "OTHERS",
      dateOfBirth: new Date("2010-10-10"),
      pan: "COMP9012D",
      settingConfig: { theme: "light" },
    },
  ];

    const accountsTemplate = [
        {
        ifsc: 'NEXA0001',
            accountType: 'SAVINGS',
            balance: 1000,
        },
        {
        ifsc: 'NEXA0001',
            accountType: 'CURRENT',
            balance: 2000,
        },
        {
        ifsc: 'SAFX0001',
            accountType: 'CREDIT_CARD',
            balance: 5000,
        },
        {
        ifsc: 'SAFX0001',
            accountType: 'CURRENT',
            balance: 3000,
        },
    ];

    const transactions = [
        {
            transactionType: 'PAYMENT',
            amount: 500,
            status: true,
            category: 'Salary',
            description: 'Monthly salary deposit',
        },
        {
            transactionType: 'TRANSFER',
            amount: 300,
            status: true,
            category: 'Payment',
            description: 'Payment for services',
        },
        {
            transactionType: 'PAYMENT',
            amount: 200,
            status: true,
            category: 'Expense',
            description: 'Utility bill payment',
        },
    ];

    for (const customerData of customers) {
        const customer = await prisma.customer.create({ data: customerData });
        for (const accountTemplate of accountsTemplate) {
            const accountData = {
                ...accountTemplate,
                accNo: await generateUniqueAccountNumber(),
                customerId: customer.id,
            };
            const account = await prisma.account.create({ data: accountData });
            for (const transactionData of transactions) {
                const receiverAccount = await prisma.account.findFirst({
                    where: {
                        accNo: {
                            not: account.accNo,
                        },
                    },
                });
                await prisma.transaction.create({
                    data: {
                        ...transactionData,
                        senderAccNo: account.accNo,
                        receiverAccNo: receiverAccount ? receiverAccount.accNo : account.accNo,
                    },
                });
            }
        }
    }
    console.log('Seeded the database with sample data');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
