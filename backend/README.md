# Warehouse Management System - Backend

This directory contains the Node.js, Express, and MSSQL backend for the WMS application.

## 1. Prerequisites

- [Node.js](https://nodejs.org/) (LTS version recommended)
- Microsoft SQL Server

## 2. Database Setup

1.  **Create a Database**: Open your SQL Server management tool (like SSMS or Azure Data Studio) and create a new database. You can name it `WarehouseDB` or any other name.

2.  **Run the Schema Script**: Open the `backend/sql/schema.sql` file provided in this project. Execute this script against your newly created database. This will create all the necessary tables (`MaterialEntries`, `LineItems`, `Users`) and populate them with initial seed data, so the application works out of the box.

## 3. Backend Configuration

1.  **Create `.env` file**: In the `backend` directory, create a new file named `.env`.

2.  **Copy Environment Variables**: Copy the contents from `.env.example` into your new `.env` file.

3.  **Update Database Credentials**: Modify the values in `.env` to match your MSSQL server configuration.

    ```env
    # Server Configuration
    API_PORT=3001

    # MS SQL Database Configuration
    DB_USER=your_db_username
    DB_PASSWORD=your_db_password
    DB_SERVER=localhost
    DB_DATABASE=WarehouseDB # The name of the database you created
    DB_PORT=1433

    # Session auth — generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
    # Rotating this value invalidates all issued sessions.
    JWT_SECRET=
    JWT_EXPIRES_IN=8h

    # Interakt WhatsApp API (Basic auth token) — used for OTP delivery and notifications
    INTERAKT_API_TOKEN=
    WHATSAPP_NOTIFY_PHONE=

    # Comma-separated list of frontend origins allowed to call this API (no wildcard)
    ALLOWED_ORIGINS=http://localhost:4200,http://localhost:4201
    ```

    **Never commit `.env`.** All values above are secrets or environment-specific and must not be hardcoded in source files.

## 4. Install Dependencies

Navigate to the `backend` directory in your terminal and install the required npm packages:

```bash
cd backend
npm install
```

## 5. Start the Server

Once the dependencies are installed, you can start the backend server:

```bash
npm start
```

The server will start, and you should see a message like `Server running on port 3001`. The frontend application is configured to connect to this local server.