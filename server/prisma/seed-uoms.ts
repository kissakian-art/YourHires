import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

function parseUnitLine(line: string) {
  line = line.trim();
  if (!line || line === '-') return null;

  let code = '';
  let name = '';
  let abbreviation = '';
  let category = 'other';

  const hyphenIndex = line.indexOf('-');
  if (hyphenIndex !== -1) {
    code = line.substring(0, hyphenIndex).trim();
    name = line.substring(hyphenIndex + 1).trim();
    abbreviation = code;
  } else {
    name = line;
    code = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
    abbreviation = line;
  }

  // Fallback check if code or name is empty
  if (!code || !name) return null;

  // Determine category based on name keywords
  const lowerName = name.toLowerCase();
  if (
    lowerName.includes('piece') || 
    lowerName.includes('dozen') || 
    lowerName.includes('box') || 
    lowerName.includes('packet') || 
    lowerName.includes('pack') || 
    lowerName.includes('unit') ||
    lowerName.includes('pair') ||
    lowerName.includes('stick')
  ) {
    category = 'quantity';
  } else if (
    lowerName.includes('kg') || 
    lowerName.includes('kilogram') || 
    lowerName.includes('gram') || 
    lowerName.includes('ton')
  ) {
    category = 'weight';
  } else if (
    lowerName.includes('litre') || 
    lowerName.includes('liter') || 
    lowerName.includes('ml') || 
    lowerName.includes('liquid') || 
    lowerName.includes('volume') || 
    lowerName.includes('gallon')
  ) {
    category = 'volume';
  } else if (
    lowerName.includes('metre') || 
    lowerName.includes('meter') || 
    lowerName.includes('yard') || 
    lowerName.includes('inch') || 
    lowerName.includes('foot')
  ) {
    category = 'length';
  } else if (
    lowerName.includes('hour') || 
    lowerName.includes('day') || 
    lowerName.includes('week') || 
    lowerName.includes('month') || 
    lowerName.includes('annum') || 
    lowerName.includes('year') || 
    lowerName.includes('minute')
  ) {
    category = 'time';
  } else if (
    lowerName.includes('container') || 
    lowerName.includes('pallet') || 
    lowerName.includes('drum') || 
    lowerName.includes('barrel') || 
    lowerName.includes('crate') || 
    lowerName.includes('bag') || 
    lowerName.includes('vial') || 
    lowerName.includes('pouch') || 
    lowerName.includes('envelope') ||
    lowerName.includes('tub') ||
    lowerName.includes('tin') ||
    lowerName.includes('sachet')
  ) {
    category = 'container';
  } else if (
    lowerName.includes('ugx') || 
    lowerName.includes('usd') || 
    lowerName.includes('currency')
  ) {
    category = 'currency';
  }

  return { code, name, abbreviation, category };
}

async function main() {
  const filePath = path.join(__dirname, '..', '..', 'units of measure.txt');
  console.log(`Reading units of measure from: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.error('Units of measure file not found!');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  console.log(`Found ${lines.length} lines. Seeding...`);

  let count = 0;
  const processedCodes = new Set<string>();

  for (const line of lines) {
    const parsed = parseUnitLine(line);
    if (!parsed) continue;

    // Prevent duplicate codes in insertion stream
    if (processedCodes.has(parsed.code)) {
      continue;
    }
    processedCodes.add(parsed.code);

    try {
      await prisma.unitOfMeasure.upsert({
        where: { code: parsed.code },
        update: {
          name: parsed.name,
          abbreviation: parsed.abbreviation,
          category: parsed.category,
        },
        create: {
          code: parsed.code,
          name: parsed.name,
          abbreviation: parsed.abbreviation,
          category: parsed.category,
        },
      });
      count++;
    } catch (err) {
      console.error(`Failed to upsert unit ${parsed.code}:`, err);
    }
  }

  console.log(`Successfully seeded ${count} units of measure!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
