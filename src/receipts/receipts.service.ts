import { Injectable } from '@nestjs/common';
import { GenerateReceiptDto } from './dto/generate-receipt.dto';

@Injectable()
export class ReceiptsService {
  async generateReceipt(dto: GenerateReceiptDto) {
    console.log('Generating receipt for ', dto);
  }
}
