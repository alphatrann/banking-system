export interface GenerateReceiptDto {
  receiptNumber: number;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  timestamp: Date;
}
