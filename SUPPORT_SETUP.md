# RentHub backend and Render setup

RentHub now serves the static site and JSON API from one Node.js service. User accounts, login sessions, favorites, and support conversations are stored in MongoDB. The backend is in `backend/`; the support inbox is in `admin/`.

## Important credential step

The MongoDB connection string previously pasted into chat contains database credentials. **Rotate that database user's password in MongoDB Atlas before deploying**, then use the newly generated connection string as an environment variable. Do not put credentials in source files or commit a real `.env` file.

## Local setup on Windows

1. Copy `.env.example` to `.env`.
2. Replace the example values in `.env` with your rotated MongoDB connection string and a unique admin email/password. Ensure the MongoDB Atlas database user and Network Access settings allow the backend to connect.
3. In PowerShell, from the project folder:

   ```powershell
   npm install
   npm start
   ```

4. Visit `http://localhost:3000` for the rental site and `http://localhost:3000/admin` for the admin inbox.

The server creates the MongoDB collections and indexes when it starts. The default database name is `house-renter`; set `MONGO_DB_NAME` to choose another database.

## Deploy to Render

1. Create a **Web Service** connected to this project.
2. Set the root directory to the project root.
3. Set the **Build Command** to `npm ci` and the **Start Command** to `npm start`. Do not enter `npm` by itself as the build command; npm requires a command such as `ci` or `install`.
4. Add these in Render's environment-variable settings:
   - `MONGO_URI`: the rotated MongoDB Atlas URI
   - `MONGO_DB_NAME`: `house-renter` (optional)
   - `RENTHUB_ADMIN_EMAIL`: your admin email
   - `RENTHUB_ADMIN_PASSWORD`: a unique password with at least 12 characters
   - `NODE_ENV`: `production`
5. In MongoDB Atlas, configure Network Access for Render. Allow only the Render outbound IP ranges when available; allowing `0.0.0.0/0` is broader access and should only be used with a strong database password and least-privilege database user.
6. Deploy, then test creating a renter account, signing in, saving a favorite, starting a support chat, and replying from `/admin`.

Use the MongoDB database user with only the permissions this application needs. Never expose `MONGO_URI` in frontend JavaScript or browser environment variables.

After deployment, the site and API are available at [https://house-renter.onrender.com](https://house-renter.onrender.com), with the admin inbox at [https://house-renter.onrender.com/admin](https://house-renter.onrender.com/admin). The frontend uses same-origin relative API paths, so API requests automatically use the current host; no production URL needs to be hardcoded. Keep `localhost` for local development only.

## Existing browser accounts

Accounts and favorites created with the earlier localStorage-only demo are not imported automatically. Renters should create new accounts after deployment; new accounts and favorites are stored in MongoDB and are available across their devices.
