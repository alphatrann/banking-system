export interface GenerateReceiptDto {
  receiptNumber: number;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  timestamp: Date;
}
