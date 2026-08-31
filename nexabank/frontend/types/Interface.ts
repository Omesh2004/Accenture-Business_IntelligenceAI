export interface Customer {
    id: string;
    name: string;
    email: string;
    phone: string;
    password: string;
    address: object;
    customerType: CustomerType;
    dateOfBirth: Date;
    pan: string;
    settingConfig: object;
    account: Account[];
    payee: Payee[];
    payer: Payee[];
}

export enum CustomerType {
    INDIVIDUAL = "INDIVIDUAL",
    SHOPPING = "SHOPPING",
    ENTERTAINMENT = "ENTERTAINMENT",
    HOUSING = "HOUSING",
    FOOD = "FOOD",
    OTHERS = "OTHERS",
}

export interface Account {
    accNo: string;
    customerId: string;
    ifsc: string;
    accountType: AccountType;
    balance: number;
    status: boolean;
    createdOn: Date;
    updatedOn: Date;
    deletedOn?: Date;
    customer: Customer;
    sent: Transaction[];
    received: Transaction[];
    loans: Loan[];
    payer: Payee[];
}

export enum AccountType {
    SAVINGS = "SAVINGS",
    CURRENT = "CURRENT",
    LOAN = "LOAN",
    CREDIT_CARD = "CREDIT_CARD",
    INVESTMENT = "INVESTMENT",
}

export interface Transaction {
    id: string;
    transactionType: TransactionType;
    senderAccNo: string;
    receiverAccNo: string;
    amount: number;
    status: boolean;
    category: string;
    description?: string;
    timestamp: Date;
    loanId?: string;
    senderAccount: Account;
    receiverAccount: Account;
    loan?: Loan;
    remark?: string;
}

export enum TransactionType {
    PAYMENT = "PAYMENT",
    TRANSFER = "TRANSFER",
}

export interface Loan {
    id: string;
    accNo: string;
    loanType: LoanType;
    interestRate: number;
    principalAmount: number;
    interestAmount: number;
    term: number;
    startDate: Date;
    endDate: Date;
    status: boolean;
    createdOn: Date;
    updatedOn: Date;
    schedule: object[];
    dueAmount: number;
    account: Account;
    payments: Transaction[];
}

export enum LoanType {
    HOME = "HOME",
    AUTO = "AUTO",
    PERSONAL = "PERSONAL",
    STUDENT = "STUDENT",
}

export interface Payee {
    id: string;
    name: string;
    payeeAccNo: string;
    payeeifsc: string;
    payeeCustomerId: string;
    payerCustomerId: string;
    payeeType: CustomerType;
    payeeAccount: Account;
    payeeCustomer: Customer;
    payerCustomer: Customer;
}