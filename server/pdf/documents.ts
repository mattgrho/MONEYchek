import PDFDocument from 'pdfkit';
import { formatMoneyForPdf } from './format';

/**
 * Deterministic, branded, server-side PDFs (no browser dependency).
 * Layout uses built-in Helvetica faces so output is reproducible; the brand
 * arrives as data (names, colors, footer text) — never hardcoded.
 */

export interface DocumentBrand {
  companyDisplayName: string;
  applicationName: string | null;
  primaryColorHex: string;
  addressLines: string[];
  phone: string | null;
  supportEmail: string | null;
  website: string | null;
  legalFooter: string | null;
  paymentInstructions: string | null;
  documentDisclaimer: string | null;
}

export interface SalesDocumentData {
  kind: 'INVOICE' | 'ESTIMATE' | 'CREDIT MEMO';
  number: string;
  issueDate: string;
  dueDate?: string | null;
  expirationDate?: string | null;
  status?: string | null;
  customer: { name: string; email?: string | null; addressLines?: string[] };
  lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
  subtotal: string;
  taxName?: string | null;
  taxTotal: string;
  total: string;
  amountPaid?: string | null;
  balanceDue?: string | null;
  memoToCustomer?: string | null;
  currency: string;
}

export interface StatementData {
  customerName: string;
  asOf: string;
  rows: { date: string; kind: string; number: string; amount: string; balance: string }[];
  endingBalance: string;
  currency: string;
}

function sanitizeHex(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#1f3a5f';
}

const M = 50; // page margin

function header(doc: PDFKit.PDFDocument, brand: DocumentBrand, title: string, number: string) {
  const primary = sanitizeHex(brand.primaryColorHex);
  doc.rect(0, 0, doc.page.width, 8).fill(primary);
  doc.fillColor('#111111');
  doc.font('Helvetica-Bold').fontSize(18).text(brand.companyDisplayName, M, 30);
  doc.font('Helvetica').fontSize(9).fillColor('#444444');
  let y = 54;
  for (const line of brand.addressLines.filter(Boolean)) {
    doc.text(line, M, y);
    y += 12;
  }
  const contact = [brand.phone, brand.supportEmail, brand.website].filter(Boolean).join('  ·  ');
  if (contact) {
    doc.text(contact, M, y);
    y += 12;
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(primary)
    .text(title, M, 34, { align: 'right', width: doc.page.width - 2 * M });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#111111')
    .text(number, M, 62, { align: 'right', width: doc.page.width - 2 * M });
  return Math.max(y + 16, 100);
}

function footer(doc: PDFKit.PDFDocument, brand: DocumentBrand) {
  const parts = [brand.legalFooter, brand.documentDisclaimer].filter(Boolean) as string[];
  if (parts.length === 0) return;
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text(parts.join('\n'), M, doc.page.height - 64, {
      width: doc.page.width - 2 * M,
      align: 'center',
    });
}

export function renderSalesDocumentPdf(
  brand: DocumentBrand,
  data: SalesDocumentData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: M,
      info: {
        Title: `${data.kind} ${data.number}`,
        Author: brand.companyDisplayName,
        CreationDate: new Date(`${data.issueDate}T00:00:00Z`),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const primary = sanitizeHex(brand.primaryColorHex);
    let y = header(doc, brand, data.kind, data.number);
    y += 10;

    // Meta block (dates) and bill-to block.
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#666666')
      .text(data.kind === 'ESTIMATE' ? 'PREPARED FOR' : 'BILL TO', M, y);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#111111')
      .text(data.customer.name, M, y + 13);
    let cy = y + 27;
    for (const line of data.customer.addressLines ?? []) {
      doc.font('Helvetica').fontSize(9).fillColor('#444444').text(line, M, cy);
      cy += 12;
    }
    if (data.customer.email) {
      doc.font('Helvetica').fontSize(9).fillColor('#444444').text(data.customer.email, M, cy);
      cy += 12;
    }

    const metaX = doc.page.width - M - 200;
    const meta: [string, string][] = [['Date', data.issueDate]];
    if (data.dueDate) meta.push(['Due date', data.dueDate]);
    if (data.expirationDate) meta.push(['Expires', data.expirationDate]);
    if (data.status) meta.push(['Status', data.status]);
    let my = y;
    for (const [label, value] of meta) {
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(label, metaX, my, { width: 90 });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#111111')
        .text(value, metaX + 95, my, { width: 105, align: 'right' });
      my += 14;
    }
    y = Math.max(cy, my) + 22;

    // Line table.
    const tableWidth = doc.page.width - 2 * M;
    const cols = { desc: tableWidth - 260, qty: 70, rate: 95, amount: 95 };
    doc.rect(M, y, tableWidth, 20).fill(primary);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    doc.text('DESCRIPTION', M + 8, y + 6, { width: cols.desc - 16 });
    doc.text('QTY', M + cols.desc, y + 6, { width: cols.qty - 8, align: 'right' });
    doc.text('RATE', M + cols.desc + cols.qty, y + 6, { width: cols.rate - 8, align: 'right' });
    doc.text('AMOUNT', M + cols.desc + cols.qty + cols.rate, y + 6, {
      width: cols.amount - 8,
      align: 'right',
    });
    y += 20;
    doc.font('Helvetica').fontSize(9);
    for (const [i, line] of data.lines.entries()) {
      const rowHeight = Math.max(
        18,
        doc.heightOfString(line.description || ' ', { width: cols.desc - 16 }) + 8,
      );
      if (y + rowHeight > doc.page.height - 160) {
        footer(doc, brand);
        doc.addPage();
        y = M;
      }
      if (i % 2 === 1) {
        doc.rect(M, y, tableWidth, rowHeight).fill('#f4f5f7');
      }
      doc.fillColor('#111111');
      doc.text(line.description || '—', M + 8, y + 5, { width: cols.desc - 16 });
      doc.text(line.quantity, M + cols.desc, y + 5, { width: cols.qty - 8, align: 'right' });
      doc.text(formatMoneyForPdf(line.unitPrice, data.currency), M + cols.desc + cols.qty, y + 5, {
        width: cols.rate - 8,
        align: 'right',
      });
      doc.text(
        formatMoneyForPdf(line.amount, data.currency),
        M + cols.desc + cols.qty + cols.rate,
        y + 5,
        { width: cols.amount - 8, align: 'right' },
      );
      y += rowHeight;
    }
    doc
      .moveTo(M, y)
      .lineTo(M + tableWidth, y)
      .strokeColor('#dddddd')
      .stroke();
    y += 10;

    // Totals block.
    const totalsX = doc.page.width - M - 220;
    const totals: [string, string, boolean][] = [['Subtotal', data.subtotal, false]];
    if (data.taxTotal && data.taxTotal !== '0.00') {
      totals.push([data.taxName ? `Tax (${data.taxName})` : 'Tax', data.taxTotal, false]);
    }
    totals.push(['Total', data.total, true]);
    if (data.amountPaid && data.amountPaid !== '0.00') {
      totals.push(['Paid', data.amountPaid, false]);
    }
    if (data.balanceDue !== undefined && data.balanceDue !== null) {
      totals.push(['Balance due', data.balanceDue, true]);
    }
    for (const [label, value, strong] of totals) {
      doc
        .font(strong ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(strong ? 11 : 9)
        .fillColor(strong ? '#111111' : '#444444')
        .text(label, totalsX, y, { width: 110 });
      doc.text(formatMoneyForPdf(value, data.currency), totalsX + 110, y, {
        width: 110,
        align: 'right',
      });
      y += strong ? 18 : 15;
    }

    if (data.memoToCustomer) {
      y += 8;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666').text('NOTES', M, y);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#333333')
        .text(data.memoToCustomer, M, y + 12, { width: tableWidth - 240 });
      y += 12 + doc.heightOfString(data.memoToCustomer, { width: tableWidth - 240 });
    }
    if (brand.paymentInstructions && data.kind === 'INVOICE') {
      y += 10;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666').text('HOW TO PAY', M, y);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#333333')
        .text(brand.paymentInstructions, M, y + 12, { width: tableWidth - 240 });
    }

    footer(doc, brand);
    doc.end();
  });
}

export function renderStatementPdf(brand: DocumentBrand, data: StatementData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: M,
      info: {
        Title: `Statement — ${data.customerName}`,
        Author: brand.companyDisplayName,
        CreationDate: new Date(`${data.asOf}T00:00:00Z`),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const primary = sanitizeHex(brand.primaryColorHex);

    let y = header(doc, brand, 'STATEMENT', `As of ${data.asOf}`);
    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666').text('FOR', M, y);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#111111')
      .text(data.customerName, M, y + 13);
    y += 40;

    const tableWidth = doc.page.width - 2 * M;
    const cols = {
      date: 90,
      kind: 130,
      number: tableWidth - 90 - 130 - 95 - 95,
      amount: 95,
      balance: 95,
    };
    doc.rect(M, y, tableWidth, 20).fill(primary);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
    doc.text('DATE', M + 8, y + 6);
    doc.text('TYPE', M + cols.date, y + 6);
    doc.text('REFERENCE', M + cols.date + cols.kind, y + 6);
    doc.text('AMOUNT', M + cols.date + cols.kind + cols.number, y + 6, {
      width: cols.amount - 8,
      align: 'right',
    });
    doc.text('BALANCE', M + cols.date + cols.kind + cols.number + cols.amount, y + 6, {
      width: cols.balance - 8,
      align: 'right',
    });
    y += 20;
    doc.font('Helvetica').fontSize(9);
    for (const [i, row] of data.rows.entries()) {
      if (y + 18 > doc.page.height - 120) {
        footer(doc, brand);
        doc.addPage();
        y = M;
      }
      if (i % 2 === 1) doc.rect(M, y, tableWidth, 18).fill('#f4f5f7');
      doc.fillColor('#111111');
      doc.text(row.date, M + 8, y + 5);
      doc.text(row.kind, M + cols.date, y + 5);
      doc.text(row.number, M + cols.date + cols.kind, y + 5);
      doc.text(
        formatMoneyForPdf(row.amount, data.currency),
        M + cols.date + cols.kind + cols.number,
        y + 5,
        {
          width: cols.amount - 8,
          align: 'right',
        },
      );
      doc.text(
        formatMoneyForPdf(row.balance, data.currency),
        M + cols.date + cols.kind + cols.number + cols.amount,
        y + 5,
        { width: cols.balance - 8, align: 'right' },
      );
      y += 18;
    }
    y += 12;
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#111111')
      .text(`Balance due: ${formatMoneyForPdf(data.endingBalance, data.currency)}`, M, y, {
        align: 'right',
        width: tableWidth,
      });
    footer(doc, brand);
    doc.end();
  });
}
