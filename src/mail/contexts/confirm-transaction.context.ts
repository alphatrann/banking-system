export interface ConfirmTransactionContext {
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  timestamp: Date;
}
