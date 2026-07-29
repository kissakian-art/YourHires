import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';

// Load env variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '3308');
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'yourhires';

export async function ensureDatabaseExists() {
  console.log(`Checking connection to MariaDB server at ${DB_HOST}:${DB_PORT}...`);
  let connection;
  try {
    // Connect to server without database selection first
    connection = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD
    });

    console.log(`Creating database '${DB_NAME}' if it does not exist...`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
    console.log(`Database verification/creation successful.`);
  } catch (error: any) {
    console.error(`Failed to verify/create database:`, error.message);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}
