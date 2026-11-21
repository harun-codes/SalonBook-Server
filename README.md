 SalonBook – Backend API

This repository contains the backend API for SalonBook, a salon appointment booking platform.

The backend handles authentication verification, salon service management, appointment booking, customer management, and secure payment processing.

The application is built using Node.js, Express.js, MongoDB, and REST APIs.

Live Application

Frontend: https://salon-book-client-pied.vercel.app

Backend API: https://salonbook-server-p7uw.onrender.com

Features

Authentication & Authorization
- JWT verification using Better Auth JWKS.
- Secure authentication middleware.
- Role-based authorization for Admin and Customer.
- Protected API endpoints.
- Blocked-user access prevention.
- Server-side permission verification.

 Service Management
- Retrieve available salon services.
- Retrieve individual service details.
- Create new salon services.
- Update existing service information.
- Delete salon services when permitted.
- Activate or deactivate services.
- Search and filter services.
- Validate service information.

 Appointment Management
- Create customer appointment requests.
- Retrieve customer-specific appointments.
- Retrieve all appointment requests for administrators.
- Confirm pending appointments.
- Cancel pending or confirmed appointments.
- Prevent duplicate bookings for the same date and time slot.
- Validate appointment status and booking information.

Customer Management
- Retrieve registered customer information.
- View individual customer details.
- Block customer accounts.
- Unblock customer accounts.
- Update permitted profile information.

 Payment Integration
- Stripe Checkout integration.
- Create secure checkout sessions.
- Validate appointment payment eligibility.
- Verify Stripe webhook signatures.
- Update payment status only after verified payment events.
- Prevent duplicate webhook event processing.
- Store transaction records.
- Retrieve payment transaction information.

 Security & Validation
- JWT verification middleware.
- Admin and customer role verification.
- Input validation.
- MongoDB ObjectId validation.
- Secure environment variable configuration.
- Stripe webhook signature verification.
- Proper API error handling.

 Technology Stack

- Node.js
- Express.js
- MongoDB Atlas
- MongoDB Native Driver
- REST API
- Better Auth
- JWT
- JOSE
- Stripe
- ImgBB
- dotenv
- CORS

API Deployment

The backend is deployed on Render.

Live API URL:

https://salonbook-server-p7uw.onrender.com

Stripe Webhook Endpoint:

POST /webhooks/stripe

 Installation & Setup

 Prerequisites
- Node.js
- npm
- MongoDB Atlas Account
- Stripe Account

 1. Clone the Server Repository


git clone https://github.com/harun-codes/SalonBook-Server

 2. Navigate to the Project Directory

cd salonbook-server


 3. Install Dependencies

npm install

 4. Configure Environment Variables

Create a .env file in the root directory and configure the following environment variables.

Required Environment Variables:

- PORT
- MONGODB_URI
- FRONTEND_URL
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_CURRENCY
- BETTER_AUTH_JWKS_URL
- BETTER_AUTH_ISSUER
- BETTER_AUTH_AUDIENCE
- APP_TIME_ZONE

Never commit .env files or expose secret credentials in the repository.

 5. Run the Backend Server

npm run dev

The backend server will run on the configured port.

 Database

SalonBook uses MongoDB Atlas to store application data.

The database manages:
- User information
- Salon services
- Appointment requests
- Payment transactions

 Payment Security

SalonBook uses Stripe Checkout for secure appointment payments.

Payment records are updated through verified Stripe webhook events rather than relying on frontend redirects.

The backend verifies webhook signatures and handles duplicate events to maintain payment consistency.

 Related Repositories

- Client Repository: https://github.com/harun-codes/SalonBook-Client
- Server Repository: https://github.com/harun-codes/SalonBook-Server

## License

This project was developed By Harun Or Roshid
