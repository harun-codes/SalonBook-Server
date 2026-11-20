import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from 'stripe';
const app = express();
const port = process.env.PORT || 5000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);


app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}));



const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const ConnectedClient = await connectToMongoDB();
const db = ConnectedClient.db('Salon-Book');
const users = db.collection("user");
const salonbook = db.collection("salonbook");
const appointments = db.collection("appointments");
const transactions = db.collection("transactions");

const stripeEvents = db.collection("stripeEvents");

await stripeEvents.createIndex(
    { eventId: 1 },
    { unique: true }
);

async function markStripeEventProcessed(event) {
    try {
        await stripeEvents.updateOne(
            {
                eventId: event.id,
            },
            {
                $setOnInsert: {
                    eventId: event.id,
                    eventType: event.type,
                    status: "processed",
                    processedAt: new Date(),
                },
            },
            {
                upsert: true,
            }
        );
    } catch (error) {
        if (error.code !== 11000) {
            throw error;
        }
    }
}

app.post("/webhooks/stripe", express.raw({ type: "application/json" }),
    async (req, res) => {
        const signature = req.headers["stripe-signature"];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!webhookSecret) {
            console.error("Stripe webhook secret is missing");

            return res.status(500).json({
                success: false,
                message: "Webhook secret is not configured",
            });
        }

        if (!signature || !Buffer.isBuffer(req.body)) {
            return res.status(400).json({
                success: false,
                message: "Invalid webhook request",
            });
        }

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                webhookSecret
            );
        } catch (error) {
            console.error(
                "Webhook signature verification failed:",
                error.message
            );

            return res.status(400).json({
                success: false,
                message: "Invalid Stripe webhook signature",
            });
        }

        try {
            const alreadyProcessed = await stripeEvents.findOne({
                eventId: event.id,
            });

            if (alreadyProcessed) {
                console.log("Duplicate Stripe event ignored:", event.id);

                return res.status(200).json({
                    received: true,
                    duplicate: true,
                    message: "Event already processed",
                });
            }

            switch (event.type) {

                case "checkout.session.completed":
                case "checkout.session.async_payment_succeeded": {
                    const session = event.data.object;

                    if (
                        session.mode !== "payment" ||
                        session.payment_status !== "paid"
                    ) {
                        return res.status(200).json({
                            received: true,
                            message: "Payment is not completed yet",
                        });
                    }

                    const {
                        appointmentId,
                        customerId,
                        serviceId,
                    } = session.metadata || {};

                    if (
                        !appointmentId ||
                        !ObjectId.isValid(appointmentId) ||
                        !customerId ||
                        !serviceId ||
                        session.client_reference_id !== appointmentId
                    ) {
                        console.error(
                            "Invalid appointment metadata:",
                            session.id
                        );

                        return res.status(400).json({
                            received: false,
                            message: "Invalid payment metadata",
                        });
                    }

                    const transaction = await transactions.findOne({
                        stripeSessionId: session.id,
                        appointmentId,
                        customerId,
                    });

                    if (!transaction) {
                        console.error(
                            "Transaction not found:",
                            session.id
                        );

                        return res.status(500).json({
                            received: false,
                            message: "Transaction not found",
                        });
                    }

                    if (
                        String(transaction.serviceId) !== String(serviceId)
                    ) {
                        return res.status(400).json({
                            received: false,
                            message: "Service reference mismatch",
                        });
                    }

                    const expectedAmount = Math.round(
                        Number(transaction.amount) * 100
                    );

                    const expectedCurrency = String(
                        transaction.currency || ""
                    ).toLowerCase();

                    if (
                        !Number.isSafeInteger(expectedAmount) ||
                        expectedAmount <= 0 ||
                        session.amount_total !== expectedAmount ||
                        session.currency !== expectedCurrency
                    ) {
                        console.error(
                            "Payment amount or currency mismatch:",
                            session.id
                        );

                        return res.status(400).json({
                            received: false,
                            message: "Payment amount or currency mismatch",
                        });
                    }

                    const appointmentObjectId = new ObjectId(
                        appointmentId
                    );

                    const appointment = await appointments.findOne({
                        _id: appointmentObjectId,
                        customerId,
                    });

                    if (!appointment) {
                        console.error(
                            "Appointment not found:",
                            appointmentId
                        );

                        return res.status(500).json({
                            received: false,
                            message: "Appointment not found",
                        });
                    }

                    if (
                        String(appointment.serviceId) !== String(serviceId)
                    ) {
                        return res.status(400).json({
                            received: false,
                            message: "Appointment service mismatch",
                        });
                    }

                    const paymentIntentId =
                        typeof session.payment_intent === "string"
                            ? session.payment_intent
                            : session.payment_intent?.id || null;

                    const now = new Date();

                    await transactions.updateOne(
                        {
                            _id: transaction._id,
                            stripeSessionId: session.id,
                        },
                        {
                            $set: {
                                status: "paid",
                                paymentStatus: "paid",
                                stripePaymentIntentId: paymentIntentId,
                                stripePaymentStatus: session.payment_status,
                                lastStripeEventId: event.id,
                                paidAt: transaction.paidAt || now,
                                updatedAt: now,
                            },
                        }
                    );

                    const appointmentUpdate = await appointments.updateOne(
                        {
                            _id: appointmentObjectId,
                            customerId,
                        },
                        {
                            $set: {
                                paymentStatus: "paid",
                                stripePaymentIntentId: paymentIntentId,
                                paidAt: appointment.paidAt || now,
                                updatedAt: now,
                            },
                        }
                    );

                    if (appointmentUpdate.matchedCount === 0) {
                        throw new Error(
                            "Appointment payment update failed"
                        );
                    }

                    await markStripeEventProcessed(event);

                    console.log(
                        "Stripe payment successfully verified:",
                        session.id
                    );

                    return res.status(200).json({
                        received: true,
                        success: true,
                        message: "Payment successfully recorded",
                    });
                }

                case "checkout.session.async_payment_failed":
                case "checkout.session.expired": {
                    const session = event.data.object;

                    const transaction = await transactions.findOne({
                        stripeSessionId: session.id,
                    });

                    if (!transaction) {
                        console.error(
                            "Transaction not found for failed or expired session:",
                            session.id
                        );

                        return res.status(500).json({
                            received: false,
                            message: "Transaction not found",
                        });
                    }

                    const nextStatus =
                        event.type === "checkout.session.expired"
                            ? "expired"
                            : "failed";

                    const now = new Date();

                    if (
                        transaction.status !== "paid" &&
                        transaction.paymentStatus !== "paid"
                    ) {
                        const transactionUpdate = await transactions.updateOne(
                            {
                                _id: transaction._id,
                                status: { $ne: "paid" },
                                paymentStatus: { $ne: "paid" },
                            },
                            {
                                $set: {
                                    status: nextStatus,
                                    paymentStatus: "unpaid",
                                    stripePaymentStatus: session.payment_status || "unpaid",
                                    lastStripeEventId: event.id,
                                    failureReason: event.type,
                                    updatedAt: now,
                                },
                            }
                        );

                        if (
                            transactionUpdate.matchedCount > 0 &&
                            ObjectId.isValid(transaction.appointmentId)
                        ) {
                            await appointments.updateOne(
                                {
                                    _id: new ObjectId(transaction.appointmentId),
                                    customerId: transaction.customerId,
                                    paymentStatus: { $ne: "paid" },
                                },
                                {
                                    $set: {
                                        paymentStatus: "unpaid",
                                        updatedAt: now,
                                    },
                                }
                            );
                        }
                    }

                    await markStripeEventProcessed(event);

                    console.log(
                        `Stripe checkout ${nextStatus}:`,
                        session.id
                    );

                    return res.status(200).json({
                        received: true,
                        success: true,
                        status: nextStatus,
                        message: `Checkout ${nextStatus} successfully recorded`,
                    });
                }

                case "payment_intent.payment_failed": {
                    const paymentIntent = event.data.object;

                    const {
                        appointmentId,
                        customerId,
                        serviceId,
                    } = paymentIntent.metadata || {};

                    if (
                        !appointmentId ||
                        !ObjectId.isValid(appointmentId) ||
                        !customerId ||
                        !serviceId
                    ) {
                        console.error(
                            "Invalid failed payment metadata:",
                            paymentIntent.id
                        );

                        return res.status(400).json({
                            received: false,
                            message: "Invalid payment metadata",
                        });
                    }

                    let transaction = await transactions.findOne({
                        stripePaymentIntentId: paymentIntent.id,
                    });

                    if (!transaction) {
                        transaction = await transactions.findOne({
                            appointmentId,
                            customerId,
                            serviceId,
                            status: "pending",
                        });
                    }

                    if (!transaction) {
                        console.error(
                            "Transaction not found for failed payment:",
                            paymentIntent.id
                        );

                        return res.status(500).json({
                            received: false,
                            message: "Transaction not found",
                        });
                    }

                    if (
                        String(transaction.appointmentId) !== String(appointmentId) ||
                        String(transaction.customerId) !== String(customerId) ||
                        String(transaction.serviceId) !== String(serviceId)
                    ) {
                        return res.status(400).json({
                            received: false,
                            message: "Transaction reference mismatch",
                        });
                    }

                    const expectedAmount = Math.round(
                        Number(transaction.amount) * 100
                    );

                    const expectedCurrency = String(
                        transaction.currency || ""
                    ).toLowerCase();

                    if (
                        !Number.isSafeInteger(expectedAmount) ||
                        expectedAmount <= 0 ||
                        paymentIntent.amount !== expectedAmount ||
                        paymentIntent.currency !== expectedCurrency
                    ) {
                        return res.status(400).json({
                            received: false,
                            message: "Payment amount or currency mismatch",
                        });
                    }

                    if (
                        transaction.status === "paid" ||
                        transaction.paymentStatus === "paid"
                    ) {
                        await markStripeEventProcessed(event);

                        console.log(
                            "Late payment failure event ignored for paid transaction:",
                            paymentIntent.id
                        );

                        return res.status(200).json({
                            received: true,
                            success: true,
                            message: "Payment already completed",
                        });
                    }

                    const paymentError = paymentIntent.last_payment_error;
                    const now = new Date();

                    const transactionUpdate = await transactions.updateOne(
                        {
                            _id: transaction._id,
                            status: { $ne: "paid" },
                            paymentStatus: { $ne: "paid" },
                        },
                        {
                            $set: {
                                stripePaymentIntentId: paymentIntent.id,
                                stripePaymentStatus: paymentIntent.status,
                                paymentStatus: "unpaid",
                                lastStripeEventId: event.id,
                                failureReason:
                                    paymentError?.decline_code ||
                                    paymentError?.code ||
                                    paymentError?.message ||
                                    event.type,
                                lastPaymentError: paymentError
                                    ? {
                                        type: paymentError.type || null,
                                        code: paymentError.code || null,
                                        declineCode: paymentError.decline_code || null,
                                        message: paymentError.message || null,
                                    }
                                    : null,
                                updatedAt: now,
                            },
                        }
                    );

                    if (transactionUpdate.matchedCount === 0) {
                        const latestTransaction = await transactions.findOne({
                            _id: transaction._id,
                        });

                        if (
                            latestTransaction?.status === "paid" ||
                            latestTransaction?.paymentStatus === "paid"
                        ) {
                            await markStripeEventProcessed(event);

                            return res.status(200).json({
                                received: true,
                                success: true,
                                message: "Payment already completed",
                            });
                        }

                        throw new Error(
                            "Failed payment transaction update failed"
                        );
                    }

                    await markStripeEventProcessed(event);

                    console.log(
                        "Stripe payment attempt failed:",
                        paymentIntent.id
                    );

                    return res.status(200).json({
                        received: true,
                        success: true,
                        status: "pending",
                        message: "Payment attempt failed. Checkout remains available for retry.",
                    });
                }

                default:
                    console.log(
                        "Unhandled Stripe event:",
                        event.type
                    );

                    return res.status(200).json({
                        received: true,
                        message: "Event ignored",
                    });
            }

        } catch (error) {
            console.error(
                "Stripe webhook processing error:",
                error
            );

            return res.status(500).json({
                received: false,
                message: "Webhook processing failed",
            });
        }
    }
);



app.use(express.json());

const TIME_SLOTS = [
    "10:00 AM",
    "11:00 AM",
    "12:00 PM",
    "01:00 PM",
    "02:00 PM",
    "03:00 PM",
    "04:00 PM",
    "05:00 PM",
    "06:00 PM",
];

await appointments.createIndex(
    {
        appointmentDate: 1,
        timeSlot: 1,
    },
    {
        unique: true,
        partialFilterExpression: {
            status: {
                $in: ["pending", "confirmed"],
            },
        },
        name: "unique_active_appointment_slot",
    }
);

await appointments.createIndex({
    customerId: 1,
    createdAt: -1,
});

const JWKS = createRemoteJWKSet(
    new URL(process.env.BETTER_AUTH_JWKS_URL)
);


const verifyCustomer = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const token = authHeader.split(" ")[1];

        const { payload } = await jwtVerify(token, JWKS, {
            issuer: process.env.BETTER_AUTH_ISSUER,
            audience: process.env.BETTER_AUTH_AUDIENCE,
        });

        if (!payload.sub) {
            return res.status(401).json({
                success: false,
                message: "Invalid authentication token",
            });
        }

        const userId = payload.sub;

        const userFilters = [
            { _id: userId },
            { id: userId },
        ];

        if (ObjectId.isValid(userId)) {
            userFilters.push({
                _id: new ObjectId(userId),
            });
        }

        const user = await users.findOne({
            $or: userFilters,
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User not found",
            });
        }

        if (user.isBlocked === true) {
            return res.status(403).json({
                success: false,
                message: "Your account has been blocked",
            });
        }

        if (user.role !== "customer") {
            return res.status(403).json({
                success: false,
                message: "Only customers can perform this action",
            });
        }

        req.authUser = {
            id: userId,
            name: user.name || "",
            email: user.email || "",
            role: user.role,
            image: user.image || "",
            phone: user.phone || "",
            mongoId: user._id,
        };
        next();
    } catch (error) {
        console.error("JWT verification error:", error.message);

        return res.status(401).json({
            success: false,
            message: "Invalid or expired authentication token",
        });
    }
};



const verifyAdmin = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authentication required",
            });
        }

        const token = authHeader.split(" ")[1];

        const { payload } = await jwtVerify(token, JWKS, {
            issuer: process.env.BETTER_AUTH_ISSUER,
            audience: process.env.BETTER_AUTH_AUDIENCE,
        });

        if (!payload.sub) {
            return res.status(401).json({
                success: false,
                message: "Invalid authentication token",
            });
        }

        const userId = payload.sub;

        const userFilters = [
            { _id: userId },
            { id: userId },
        ];

        if (ObjectId.isValid(userId)) {
            userFilters.push({
                _id: new ObjectId(userId),
            });
        }

        const user = await users.findOne({
            $or: userFilters,
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User not found",
            });
        }

        if (user.isBlocked === true) {
            return res.status(403).json({
                success: false,
                message: "Your account has been blocked",
            });
        }

        if (user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Only admins can perform this action",
            });
        }

        req.authUser = {
            id: userId,
            name: user.name || "",
            email: user.email || "",
            role: user.role,
            image: user.image || "",
            phone: user.phone || "",
            mongoId: user._id,
        };

        next();

    } catch (error) {
        console.error("JWT verification error:", error.message);

        return res.status(401).json({
            success: false,
            message: "Invalid or expired authentication token",
        });
    }
};




function getAppointmentDateTime(date, timeSlot) {
    const [clock, period] = timeSlot.split(" ");
    const [hourString, minuteString] = clock.split(":");

    let hour = Number(hourString);

    if (period === "PM" && hour !== 12) {
        hour += 12;
    }

    if (period === "AM" && hour === 12) {
        hour = 0;
    }

    return new Date(
        `${date}T${String(hour).padStart(2, "0")}:${minuteString}:00+06:00`
    );
}



app.get('/', async (req, res) => {
    res.send('Salon Book Server is Running Succesfully')
})




// user related api

app.get("/users/me", verifyCustomer, async (req, res) => {
    try {
        return res.status(200).json({
            success: true,
            user: {
                id: req.authUser.id,
                name: req.authUser.name,
                email: req.authUser.email,
                image: req.authUser.image,
                phone: req.authUser.phone,
                role: req.authUser.role,
            },
        });
    } catch (error) {
        console.error("Fetch profile error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch profile",
        });
    }
});


app.patch("/users/me", verifyCustomer, async (req, res) => {
    try {
        const { name, phone, image } = req.body;

        const updates = {};

        if (name !== undefined) {
            if (
                typeof name !== "string" ||
                name.trim().length < 2 ||
                name.trim().length > 60
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Name must contain 2-60 characters",
                });
            }

            updates.name = name.trim();
        }

        if (phone !== undefined) {
            if (typeof phone !== "string" || phone.length > 25) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid phone number",
                });
            }

            const cleanPhone = phone.trim();

            if (
                cleanPhone &&
                !/^[+()\d\s-]{7,20}$/.test(cleanPhone)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid phone number",
                });
            }

            updates.phone = cleanPhone;
        }

        if (image !== undefined) {
            if (typeof image !== "string" || image.length > 2048) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid profile image",
                });
            }

            if (image !== "") {
                try {
                    const imageUrl = new URL(image);

                    if (
                        imageUrl.protocol !== "https:" ||
                        !["i.ibb.co", "ibb.co"].includes(imageUrl.hostname)
                    ) {
                        return res.status(400).json({
                            success: false,
                            message: "Invalid profile image URL",
                        });
                    }
                } catch {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid profile image URL",
                    });
                }
            }

            updates.image = image;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No profile information provided",
            });
        }

        const userFilter = req.authUser.mongoId !== undefined
            ? { _id: req.authUser.mongoId }
            : { id: req.authUser.id };

        const result = await users.updateOne(
            userFilter,
            {
                $set: {
                    ...updates,
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            user: {
                id: req.authUser.id,
                name: updates.name ?? req.authUser.name,
                email: req.authUser.email,
                phone: updates.phone ?? req.authUser.phone,
                image: updates.image ?? req.authUser.image,
            },
        });
    } catch (error) {
        console.error("Update profile error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to update profile",
        });
    }
});


app.get("/admin/users", verifyAdmin, async (req, res) => {
    try {
        const search =
            typeof req.query.search === "string"
                ? req.query.search.trim().slice(0, 100)
                : "";

        const pageParam =
            typeof req.query.page === "string"
                ? parseInt(req.query.page, 10)
                : 1;

        const limitParam =
            typeof req.query.limit === "string"
                ? parseInt(req.query.limit, 10)
                : 10;

        const page =
            Number.isInteger(pageParam) && pageParam > 0
                ? pageParam
                : 1;

        const limit =
            Number.isInteger(limitParam) && limitParam > 0
                ? Math.min(limitParam, 100)
                : 10;

        const blocked =
            typeof req.query.blocked === "string"
                ? req.query.blocked.toLowerCase()
                : "all";

        if (!["all", "true", "false"].includes(blocked)) {
            return res.status(400).json({
                success: false,
                message: "Invalid blocked status filter",
            });
        }

        const filter = {
            role: "customer",
        };

        if (blocked === "true") {
            filter.isBlocked = true;
        }

        if (blocked === "false") {
            filter.isBlocked = { $ne: true };
        }

        if (search) {
            const escapedSearch = search.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );

            const searchRegex = new RegExp(escapedSearch, "i");

            filter.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
            ];
        }

        const total = await users.countDocuments(filter);

        const customerUsers = await users
            .find(filter, {
                projection: {
                    name: 1,
                    email: 1,
                    phone: 1,
                    image: 1,
                    role: 1,
                    isBlocked: 1,
                    id: 1,
                    createdAt: 1,
                    updatedAt: 1,
                },
            })
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

        const result = customerUsers.map((user) => ({
            id: user.id || user._id.toString(),
            name: user.name || "",
            email: user.email || "",
            phone: user.phone || "",
            image: user.image || "",
            role: user.role,
            isBlocked: user.isBlocked === true,
            createdAt: user.createdAt || null,
            updatedAt: user.updatedAt || null,
        }));

        return res.status(200).json({
            success: true,
            count: total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            users: result,
        });

    } catch (error) {
        console.error("Admin fetch users error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch users",
        });
    }
});


app.get("/admin/users/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || id.trim().length > 128) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID",
            });
        }

        const userFilters = [
            { id },
            { _id: id },
        ];

        if (ObjectId.isValid(id)) {
            userFilters.push({
                _id: new ObjectId(id),
            });
        }

        const user = await users.findOne(
            {
                $and: [
                    { $or: userFilters },
                    { role: "customer" },
                ],
            },
            {
                projection: {
                    name: 1,
                    email: 1,
                    phone: 1,
                    image: 1,
                    role: 1,
                    isBlocked: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    id: 1,
                },
            }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        return res.status(200).json({
            success: true,
            user: {
                id: user.id || user._id.toString(),
                name: user.name || "",
                email: user.email || "",
                phone: user.phone || "",
                image: user.image || "",
                role: user.role,
                isBlocked: user.isBlocked === true,
                createdAt: user.createdAt || null,
                updatedAt: user.updatedAt || null,
            },
        });

    } catch (error) {
        console.error("Admin fetch user details error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch customer details",
        });
    }
});


app.patch("/admin/users/:id/block", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || id.trim().length > 128) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID",
            });
        }

        const userFilters = [
            { id },
            { _id: id },
        ];

        if (ObjectId.isValid(id)) {
            userFilters.push({
                _id: new ObjectId(id),
            });
        }

        const customerFilter = {
            $and: [
                { $or: userFilters },
                { role: "customer" },
            ],
        };

        const customer = await users.findOne(customerFilter);

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        if (customer.isBlocked === true) {
            return res.status(409).json({
                success: false,
                message: "Customer is already blocked",
            });
        }

        await users.updateOne(
            {
                _id: customer._id,
                role: "customer",
                isBlocked: { $ne: true },
            },
            {
                $set: {
                    isBlocked: true,
                    updatedAt: new Date(),
                },
            }
        );

        const updatedCustomer = await users.findOne(
            { _id: customer._id },
            {
                projection: {
                    name: 1,
                    email: 1,
                    phone: 1,
                    image: 1,
                    role: 1,
                    isBlocked: 1,
                    id: 1,
                    updatedAt: 1,
                },
            }
        );

        if (!updatedCustomer || updatedCustomer.isBlocked !== true) {
            return res.status(409).json({
                success: false,
                message: "Unable to block customer",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Customer blocked successfully",
            user: {
                id: updatedCustomer.id || updatedCustomer._id.toString(),
                name: updatedCustomer.name || "",
                email: updatedCustomer.email || "",
                phone: updatedCustomer.phone || "",
                image: updatedCustomer.image || "",
                role: updatedCustomer.role,
                isBlocked: updatedCustomer.isBlocked,
                updatedAt: updatedCustomer.updatedAt,
            },
        });

    } catch (error) {
        console.error("Block customer error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to block customer",
        });
    }
});


app.patch("/admin/users/:id/unblock", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || id.trim().length > 128) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID",
            });
        }

        const userFilters = [
            { id },
            { _id: id },
        ];

        if (ObjectId.isValid(id)) {
            userFilters.push({
                _id: new ObjectId(id),
            });
        }

        const customerFilter = {
            $and: [
                { $or: userFilters },
                { role: "customer" },
            ],
        };

        const customer = await users.findOne(customerFilter);

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        if (customer.isBlocked !== true) {
            return res.status(409).json({
                success: false,
                message: "Customer is already active",
            });
        }

        const result = await users.updateOne(
            {
                _id: customer._id,
                role: "customer",
                isBlocked: true,
            },
            {
                $set: {
                    isBlocked: false,
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            return res.status(409).json({
                success: false,
                message: "Customer status has already changed",
            });
        }

        const updatedCustomer = await users.findOne(
            { _id: customer._id },
            {
                projection: {
                    name: 1,
                    email: 1,
                    phone: 1,
                    image: 1,
                    role: 1,
                    isBlocked: 1,
                    id: 1,
                    updatedAt: 1,
                },
            }
        );

        return res.status(200).json({
            success: true,
            message: "Customer unblocked successfully",
            user: {
                id: updatedCustomer.id || updatedCustomer._id.toString(),
                name: updatedCustomer.name || "",
                email: updatedCustomer.email || "",
                phone: updatedCustomer.phone || "",
                image: updatedCustomer.image || "",
                role: updatedCustomer.role,
                isBlocked: updatedCustomer.isBlocked,
                updatedAt: updatedCustomer.updatedAt,
            },
        });

    } catch (error) {
        console.error("Unblock customer error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to unblock customer",
        });
    }
});




// services related Api

app.get("/services", async (req, res) => {
    try {
        const result = await db
            .collection("salonbook")
            .find({ status: "active" })
            .sort({ createdAt: -1 })
            .toArray();

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Failed to fetch services",
        });
    }
});


app.get('/services/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: 'Invalid service ID' });
        }

        const result = await db.collection('salonbook').findOne({
            _id: new ObjectId(id),
            status: "active",
        });

        if (!result) {
            return res.status(404).send({ message: 'Service not found' });
        }

        res.status(200).send(result);
    } catch (error) {
        res.status(500).send({ message: 'Failed to fetch service' });
    }
});


app.get("/admin/services", verifyAdmin, async (req, res) => {
    try {
        const filter = {};

        const search = req.query.search;
        const status = req.query.status;

        if (status !== undefined) {
            if (
                typeof status !== "string" ||
                !["all", "active", "inactive"].includes(status.toLowerCase())
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service status",
                });
            }

            if (status.toLowerCase() !== "all") {
                filter.status = status.toLowerCase();
            }
        }

        if (search !== undefined) {
            if (typeof search !== "string") {
                return res.status(400).json({
                    success: false,
                    message: "Invalid search query",
                });
            }

            const cleanSearch = search.trim();

            if (cleanSearch) {
                const safeSearch = cleanSearch.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&"
                );

                filter.$or = [
                    {
                        serviceName: {
                            $regex: safeSearch,
                            $options: "i",
                        },
                    },
                    {
                        category: {
                            $regex: safeSearch,
                            $options: "i",
                        },
                    },
                ];
            }
        }

        const services = await salonbook
            .find(filter)
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({
            success: true,
            count: services.length,
            services,
        });

    } catch (error) {
        console.error("Admin fetch services error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch services",
        });
    }
});


app.get("/admin/services/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid service ID",
            });
        }

        const service = await salonbook.findOne({
            _id: new ObjectId(id),
        });

        if (!service) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        return res.status(200).json({
            success: true,
            service,
        });

    } catch (error) {
        console.error("Admin fetch single service error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch service",
        });
    }
});


const isValidImgBBUrl = (value) => {
    if (
        typeof value !== "string" ||
        !value.trim() ||
        value.trim().length > 2048
    ) {
        return false;
    }

    try {
        const imageUrl = new URL(value.trim());

        return (
            imageUrl.protocol === "https:" &&
            ["i.ibb.co", "ibb.co"].includes(
                imageUrl.hostname.toLowerCase()
            ) &&
            !imageUrl.username &&
            !imageUrl.password
        );
    } catch {
        return false;
    }
};


app.post("/admin/services", verifyAdmin, async (req, res) => {
    try {
        const {
            serviceName,
            category,
            description,
            price,
            duration,
            image = "",
            status = "active",
        } = req.body || {};

        const cleanName =
            typeof serviceName === "string"
                ? serviceName.trim()
                : "";

        const cleanCategory =
            typeof category === "string"
                ? category.trim()
                : "";

        const cleanDescription =
            typeof description === "string"
                ? description.trim()
                : "";

        const cleanImage =
            typeof image === "string"
                ? image.trim()
                : "";

        const cleanStatus =
            typeof status === "string"
                ? status.toLowerCase()
                : "";

        const servicePrice = Number(price);
        const serviceDuration = Number(duration);

        if (cleanName.length < 2 || cleanName.length > 100) {
            return res.status(400).json({
                success: false,
                message: "Service name must contain 2-100 characters",
            });
        }

        if (cleanCategory.length < 2 || cleanCategory.length > 60) {
            return res.status(400).json({
                success: false,
                message: "Invalid service category",
            });
        }

        if (
            !cleanDescription ||
            cleanDescription.length > 2000
        ) {
            return res.status(400).json({
                success: false,
                message: "Description is required and must not exceed 2000 characters",
            });
        }

        if (
            !Number.isFinite(servicePrice) ||
            servicePrice <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid service price",
            });
        }

        if (
            !Number.isInteger(serviceDuration) ||
            serviceDuration <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid service duration",
            });
        }

        if (!cleanImage || !isValidImgBBUrl(cleanImage)) {
            return res.status(400).json({
                success: false,
                message: "Please upload a valid ImgBB service image",
            });
        }

        if (!["active", "inactive"].includes(cleanStatus)) {
            return res.status(400).json({
                success: false,
                message: "Invalid service status",
            });
        }

        const newService = {
            serviceName: cleanName,
            category: cleanCategory,
            description: cleanDescription,
            price: servicePrice,
            duration: serviceDuration,
            image: cleanImage,
            status: cleanStatus,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await salonbook.insertOne(newService);

        return res.status(201).json({
            success: true,
            message: "Service created successfully",
            service: {
                _id: result.insertedId,
                ...newService,
            },
        });

    } catch (error) {
        console.error("Create service error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to create service",
        });
    }
});


app.patch("/admin/services/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid service ID",
            });
        }

        const body = req.body;

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json({
                success: false,
                message: "Invalid request body",
            });
        }

        const updates = {};

        if (Object.prototype.hasOwnProperty.call(body, "serviceName")) {
            if (
                typeof body.serviceName !== "string" ||
                body.serviceName.trim().length < 2 ||
                body.serviceName.trim().length > 100
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service name",
                });
            }

            updates.serviceName = body.serviceName.trim();
        }

        if (Object.prototype.hasOwnProperty.call(body, "category")) {
            if (
                typeof body.category !== "string" ||
                body.category.trim().length < 2 ||
                body.category.trim().length > 60
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service category",
                });
            }

            updates.category = body.category.trim();
        }

        if (Object.prototype.hasOwnProperty.call(body, "description")) {
            if (
                typeof body.description !== "string" ||
                !body.description.trim() ||
                body.description.trim().length > 2000
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service description",
                });
            }

            updates.description = body.description.trim();
        }

        if (Object.prototype.hasOwnProperty.call(body, "price")) {
            const price = Number(body.price);

            if (!Number.isFinite(price) || price <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service price",
                });
            }

            updates.price = price;
        }

        if (Object.prototype.hasOwnProperty.call(body, "duration")) {
            const duration = Number(body.duration);

            if (!Number.isInteger(duration) || duration <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service duration",
                });
            }

            updates.duration = duration;
        }

        if (Object.prototype.hasOwnProperty.call(body, "image")) {
            if (
                typeof body.image !== "string" ||
                body.image.trim().length > 2048
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service image",
                });
            }

            const image = body.image.trim();

            if (image && !isValidImgBBUrl(image)) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid ImgBB image URL",
                });
            }

            updates.image = image;
        }

        if (Object.prototype.hasOwnProperty.call(body, "status")) {
            if (
                typeof body.status !== "string" ||
                !["active", "inactive"].includes(body.status.toLowerCase())
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service status",
                });
            }

            updates.status = body.status.toLowerCase();
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid service information provided",
            });
        }

        updates.updatedAt = new Date();

        const serviceId = new ObjectId(id);

        const result = await salonbook.updateOne(
            { _id: serviceId },
            { $set: updates }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        const updatedService = await salonbook.findOne({
            _id: serviceId,
        });

        return res.status(200).json({
            success: true,
            message: "Service updated successfully",
            service: updatedService,
        });

    } catch (error) {
        console.error("Update service error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to update service",
        });
    }
});


app.delete("/admin/services/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid service ID",
            });
        }

        const serviceId = new ObjectId(id);

        const service = await salonbook.findOne({
            _id: serviceId,
        });

        if (!service) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        const linkedAppointments = await appointments.countDocuments({
            $or: [
                { serviceId: id },
                { serviceId: serviceId },
            ],
        });

        if (linkedAppointments > 0) {
            return res.status(409).json({
                success: false,
                message:
                    "This service has appointment records. Deactivate it instead of deleting.",
                linkedAppointments,
            });
        }

        const result = await salonbook.deleteOne({
            _id: serviceId,
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Service not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Service deleted successfully",
        });

    } catch (error) {
        console.error("Delete service error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to delete service",
        });
    }
});




// appoinments related api

app.post("/appointments", verifyCustomer, async (req, res) => {
    try {
        const {
            serviceId,
            appointmentDate,
            timeSlot,
            message = "",
        } = req.body;

        if (!ObjectId.isValid(serviceId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid service ID",
            });
        }

        if (
            typeof appointmentDate !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid appointment date",
            });
        }

        const parsedDate = new Date(
            `${appointmentDate}T00:00:00.000Z`
        );

        if (
            Number.isNaN(parsedDate.getTime()) ||
            parsedDate.toISOString().slice(0, 10) !== appointmentDate
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid appointment date",
            });
        }

        const today = new Intl.DateTimeFormat("en-CA", {
            timeZone: process.env.APP_TIME_ZONE || "Asia/Dhaka",
        }).format(new Date());

        if (appointmentDate < today) {
            return res.status(400).json({
                success: false,
                message: "Appointment date cannot be in the past",
            });
        }

        if (!TIME_SLOTS.includes(timeSlot)) {
            return res.status(400).json({
                success: false,
                message: "Invalid appointment time slot",
            });
        }

        if (getAppointmentDateTime(appointmentDate, timeSlot) <= new Date()) {
            return res.status(400).json({
                success: false,
                message: "Please select a future time slot",
            });
        }

        if (typeof message !== "string" || message.length > 500) {
            return res.status(400).json({
                success: false,
                message: "Message must not exceed 500 characters",
            });
        }

        const service = await salonbook.findOne({
            _id: new ObjectId(serviceId),
            status: "active",
        });

        if (!service) {
            return res.status(404).json({
                success: false,
                message: "Service is unavailable for booking",
            });
        }

        const appointment = {
            serviceId: service._id.toString(),
            customerId: req.authUser.id,
            appointmentDate,
            timeSlot,
            message: message.trim(),
            servicePrice: Number(service.price),
            status: "pending",
            paymentStatus: "unpaid",
            createdAt: new Date(),
        };

        const result = await appointments.insertOne(appointment);

        return res.status(201).json({
            success: true,
            message: "Appointment request submitted successfully",
            appointment: {
                _id: result.insertedId,
                ...appointment,
            },
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: "This time slot is already booked. Please choose another time.",
            });
        }

        console.error("Appointment creation error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to create appointment",
        });
    }
});



app.get("/appointments/my", verifyCustomer, async (req, res) => {
    try {
        const customerAppointments = await appointments
            .find({
                customerId: req.authUser.id,
            })
            .sort({ createdAt: -1 })
            .toArray();

        const serviceIds = [
            ...new Set(
                customerAppointments
                    .map((appointment) => appointment.serviceId)
                    .filter((id) => ObjectId.isValid(id))
            ),
        ].map((id) => new ObjectId(id));

        const services = serviceIds.length
            ? await salonbook
                .find({ _id: { $in: serviceIds } })
                .toArray()
            : [];

        const serviceMap = new Map(
            services.map((service) => [
                service._id.toString(),
                service,
            ])
        );

        const result = customerAppointments.map((appointment) => ({
            ...appointment,
            service: serviceMap.get(appointment.serviceId) || null,
        }));

        return res.status(200).json({
            success: true,
            count: result.length,
            appointments: result,
        });
    } catch (error) {
        console.error("Fetch appointments error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch appointments",
        });
    }
});



app.patch("/appointments/:id/cancel", verifyCustomer, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid appointment ID",
            });
        }

        const appointmentId = new ObjectId(id);

        const filter = {
            _id: appointmentId,
            customerId: req.authUser.id,
            status: "pending",
        };

        const result = await appointments.updateOne(
            filter,
            {
                $set: {
                    status: "cancelled",
                    cancelledAt: new Date(),
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            const existingAppointment = await appointments.findOne({
                _id: appointmentId,
                customerId: req.authUser.id,
            });

            if (!existingAppointment) {
                return res.status(404).json({
                    success: false,
                    message: "Appointment not found",
                });
            }

            return res.status(409).json({
                success: false,
                message: "Only pending appointments can be cancelled",
            });
        }

        const updatedAppointment = await appointments.findOne({
            _id: appointmentId,
            customerId: req.authUser.id,
        });

        return res.status(200).json({
            success: true,
            message: "Appointment cancelled successfully",
            appointment: updatedAppointment,
        });
    } catch (error) {
        console.error("Cancel appointment error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to cancel appointment",
        });
    }
});


app.get("/admin/appointments", verifyAdmin, async (req, res) => {
    try {
        const status =
            typeof req.query.status === "string"
                ? req.query.status.trim().toLowerCase()
                : "";

        const page = Math.max(
            parseInt(req.query.page, 10) || 1,
            1
        );

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 10, 1),
            100
        );

        const filter = {};

        if (status && status !== "all") {
            filter.status = status;
        }

        const total = await appointments.countDocuments(filter);

        const appointmentList = await appointments
            .find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

        const serviceIds = [
            ...new Set(
                appointmentList
                    .map((appointment) => appointment.serviceId)
                    .filter((id) => ObjectId.isValid(id))
            ),
        ].map((id) => new ObjectId(id));

        const customerIds = [
            ...new Set(
                appointmentList
                    .map((appointment) => appointment.customerId)
                    .filter(Boolean)
            ),
        ];

        const [services, customers] = await Promise.all([
            serviceIds.length
                ? salonbook.find({
                    _id: { $in: serviceIds },
                }).toArray()
                : [],

            customerIds.length
                ? users.find(
                    {
                        $or: customerIds.flatMap((id) => [
                            { id },
                            { _id: id },
                            ...(ObjectId.isValid(id)
                                ? [{ _id: new ObjectId(id) }]
                                : []),
                        ]),
                    },
                    {
                        projection: {
                            name: 1,
                            email: 1,
                            phone: 1,
                            image: 1,
                            role: 1,
                            id: 1,
                        },
                    }
                ).toArray()
                : [],
        ]);

        const serviceMap = new Map(
            services.map((service) => [
                service._id.toString(),
                service,
            ])
        );

        const customerMap = new Map();

        customers.forEach((customer) => {
            if (customer.id) {
                customerMap.set(String(customer.id), customer);
            }

            if (customer._id) {
                customerMap.set(
                    customer._id.toString(),
                    customer
                );
            }
        });

        const result = appointmentList.map((appointment) => {
            const customer = customerMap.get(
                appointment.customerId
            );

            return {
                ...appointment,
                _id: appointment._id.toString(),

                service:
                    serviceMap.get(appointment.serviceId) || null,

                customer: customer
                    ? {
                        id: customer.id || customer._id.toString(),
                        name: customer.name || "",
                        email: customer.email || "",
                        phone: customer.phone || "",
                        image: customer.image || "",
                    }
                    : null,
            };
        });

        return res.status(200).json({
            success: true,
            count: total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            appointments: result,
        });

    } catch (error) {
        console.error("Admin fetch appointments error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch appointments",
        });
    }
});


app.get("/admin/appointments/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid appointment ID",
            });
        }

        const appointment = await appointments.findOne({
            _id: new ObjectId(id),
        });

        if (!appointment) {
            return res.status(404).json({
                success: false,
                message: "Appointment not found",
            });
        }

        const service = ObjectId.isValid(appointment.serviceId)
            ? await salonbook.findOne({
                _id: new ObjectId(appointment.serviceId),
            })
            : null;

        const userFilters = [
            { _id: appointment.customerId },
            { id: appointment.customerId },
        ];

        if (ObjectId.isValid(appointment.customerId)) {
            userFilters.push({
                _id: new ObjectId(appointment.customerId),
            });
        }

        const customer = await users.findOne(
            { $or: userFilters },
            {
                projection: {
                    name: 1,
                    email: 1,
                    phone: 1,
                    image: 1,
                    role: 1,
                    id: 1,
                },
            }
        );

        return res.status(200).json({
            success: true,
            appointment: {
                ...appointment,
                _id: appointment._id.toString(),
                service: service || null,
                customer: customer
                    ? {
                        id: customer.id || customer._id.toString(),
                        name: customer.name || "",
                        email: customer.email || "",
                        phone: customer.phone || "",
                        image: customer.image || "",
                    }
                    : null,
            },
        });

    } catch (error) {
        console.error("Admin fetch appointment details error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch appointment details",
        });
    }
});


app.patch("/admin/appointments/:id/confirm", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid appointment ID",
            });
        }

        const appointmentId = new ObjectId(id);

        const result = await appointments.updateOne(
            {
                _id: appointmentId,
                status: "pending",
            },
            {
                $set: {
                    status: "confirmed",
                    confirmedAt: new Date(),
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            const existingAppointment = await appointments.findOne({
                _id: appointmentId,
            });

            if (!existingAppointment) {
                return res.status(404).json({
                    success: false,
                    message: "Appointment not found",
                });
            }

            return res.status(409).json({
                success: false,
                message: "Only pending appointments can be confirmed",
            });
        }

        const updatedAppointment = await appointments.findOne({
            _id: appointmentId,
        });

        return res.status(200).json({
            success: true,
            message: "Appointment confirmed successfully",
            appointment: updatedAppointment,
        });

    } catch (error) {
        console.error("Confirm appointment error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to confirm appointment",
        });
    }
});



app.patch("/admin/appointments/:id/cancel", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid appointment ID",
            });
        }

        const appointmentId = new ObjectId(id);

        const result = await appointments.updateOne(
            {
                _id: appointmentId,
                status: { $in: ["pending", "confirmed"] },
            },
            {
                $set: {
                    status: "cancelled",
                    cancelledAt: new Date(),
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            const existingAppointment = await appointments.findOne({
                _id: appointmentId,
            });

            if (!existingAppointment) {
                return res.status(404).json({
                    success: false,
                    message: "Appointment not found",
                });
            }

            return res.status(409).json({
                success: false,
                message: "Only pending or confirmed appointments can be cancelled",
            });
        }

        const updatedAppointment = await appointments.findOne({
            _id: appointmentId,
        });

        return res.status(200).json({
            success: true,
            message: "Appointment cancelled successfully",
            appointment: updatedAppointment,
        });

    } catch (error) {
        console.error("Admin cancel appointment error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to cancel appointment",
        });
    }
});


// admin dashboard related api 

app.get("/admin/dashboard/stats", verifyAdmin, async (req, res) => {
    try {
        const [
            totalCustomers,
            totalActiveServices,
            totalAppointments,
            pendingAppointments,
            confirmedAppointments,
            totalSuccessfulPayments,
        ] = await Promise.all([
            users.countDocuments({
                role: "customer",
            }),

            salonbook.countDocuments({
                status: "active",
            }),

            appointments.countDocuments({}),

            appointments.countDocuments({
                status: "pending",
            }),

            appointments.countDocuments({
                status: "confirmed",
            }),

            transactions.countDocuments({
                status: "paid",
            }),
        ]);

        return res.status(200).json({
            success: true,
            stats: {
                totalCustomers,
                totalActiveServices,
                totalAppointments,
                pendingAppointments,
                confirmedAppointments,
                totalSuccessfulPayments,
            },
        });
    } catch (error) {
        console.error("Admin dashboard stats error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to load dashboard statistics.",
        });
    }
});


// admin profile api

app.get("/admin/profile", verifyAdmin, async (req, res) => {
    try {
        const admin = await users.findOne(
            { _id: req.authUser.mongoId },
            {
                projection: {
                    name: 1,
                    email: 1,
                    image: 1,
                    phone: 1,
                    role: 1,
                    createdAt: 1,
                    updatedAt: 1,
                },
            }
        );

        if (!admin) {
            return res.status(404).json({
                success: false,
                message: "Admin profile not found",
            });
        }

        return res.status(200).json({
            success: true,
            user: {
                id: admin._id.toString(),
                name: admin.name || "",
                email: admin.email || "",
                image: admin.image || "",
                phone: admin.phone || "",
                role: admin.role || "admin",
                createdAt: admin.createdAt || null,
                updatedAt: admin.updatedAt || null,
            },
        });
    } catch (error) {
        console.error("Fetch admin profile error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch admin profile",
        });
    }
});


app.patch("/admin/profile", verifyAdmin, async (req, res) => {
    try {
        const { name, phone, image } = req.body;

        const updates = {};

        if (name !== undefined) {
            if (
                typeof name !== "string" ||
                name.trim().length < 2 ||
                name.trim().length > 60
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Name must contain 2-60 characters",
                });
            }

            updates.name = name.trim();
        }

        if (phone !== undefined) {
            if (
                typeof phone !== "string" ||
                phone.length > 25
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid phone number",
                });
            }

            const cleanPhone = phone.trim();

            if (
                cleanPhone &&
                !/^[+()\d\s-]{7,20}$/.test(cleanPhone)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Please provide a valid phone number",
                });
            }

            updates.phone = cleanPhone;
        }

        if (image !== undefined) {
            if (
                typeof image !== "string" ||
                image.length > 2048
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid profile image",
                });
            }

            const cleanImage = image.trim();

            if (cleanImage !== "") {
                try {
                    const imageUrl = new URL(cleanImage);

                    if (
                        imageUrl.protocol !== "https:" ||
                        !imageUrl.hostname ||
                        imageUrl.username ||
                        imageUrl.password
                    ) {
                        return res.status(400).json({
                            success: false,
                            message: "Invalid profile image URL",
                        });
                    }
                } catch {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid profile image URL",
                    });
                }
            }

            updates.image = cleanImage;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No profile information provided",
            });
        }

        const result = await users.updateOne(
            { _id: req.authUser.mongoId },
            {
                $set: {
                    ...updates,
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Admin not found",
            });
        }

        const updatedAdmin = await users.findOne(
            { _id: req.authUser.mongoId },
            {
                projection: {
                    name: 1,
                    email: 1,
                    image: 1,
                    phone: 1,
                    role: 1,
                    createdAt: 1,
                    updatedAt: 1,
                },
            }
        );

        if (!updatedAdmin) {
            return res.status(404).json({
                success: false,
                message: "Admin profile not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Admin profile updated successfully",
            user: {
                id: updatedAdmin._id.toString(),
                name: updatedAdmin.name || "",
                email: updatedAdmin.email || "",
                image: updatedAdmin.image || "",
                phone: updatedAdmin.phone || "",
                role: updatedAdmin.role || "admin",
                createdAt: updatedAdmin.createdAt || null,
                updatedAt: updatedAdmin.updatedAt || null,
            },
        });
    } catch (error) {
        console.error("Update admin profile error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to update admin profile",
        });
    }
});


app.post("/appointments/:id/create-checkout-session", verifyCustomer,
    async (req, res) => {
        try {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid appointment ID",
                });
            }

            const configuredFrontendUrl = process.env.FRONTEND_URL?.trim();

            if (!configuredFrontendUrl) {
                return res.status(500).json({
                    success: false,
                    message: "Frontend URL is not configured",
                });
            }

            const frontendUrl = configuredFrontendUrl.replace(/\/+$/, "");

            try {
                const parsedUrl = new URL(frontendUrl);

                if (!["http:", "https:"].includes(parsedUrl.protocol)) {
                    throw new Error("Invalid protocol");
                }
            } catch {
                return res.status(500).json({
                    success: false,
                    message: "Invalid frontend URL configuration",
                });
            }

            const appointmentId = new ObjectId(id);
            const customerId = req.authUser.id;

            const appointment = await appointments.findOne({
                _id: appointmentId,
                customerId,
            });

            if (!appointment) {
                return res.status(404).json({
                    success: false,
                    message: "Appointment not found",
                });
            }

            if (
                String(appointment.status).toLowerCase() !== "confirmed"
            ) {
                return res.status(409).json({
                    success: false,
                    message: "Only confirmed appointments can be paid",
                });
            }

            if (
                String(appointment.paymentStatus).toLowerCase() !== "unpaid"
            ) {
                return res.status(409).json({
                    success: false,
                    message: "This appointment is not eligible for payment",
                });
            }

            const serviceId = appointment.serviceId;

            if (!ObjectId.isValid(serviceId)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service reference",
                });
            }

            const service = await salonbook.findOne({
                _id: new ObjectId(serviceId),
            });

            if (!service) {
                return res.status(404).json({
                    success: false,
                    message: "Associated service not found",
                });
            }

            const amount = Number(appointment.servicePrice);

            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid appointment payment amount",
                });
            }

            const amountInMinorUnit = Math.round(amount * 100);

            if (
                !Number.isSafeInteger(amountInMinorUnit) ||
                amountInMinorUnit <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid payment amount",
                });
            }

            const currency = (
                process.env.STRIPE_CURRENCY || "bdt"
            ).toLowerCase();

            const appointmentIdString = appointmentId.toString();

            const successUrl = `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`;

            const cancelUrl = `${frontendUrl}/payment/cancel`;

            const existingTransaction = await transactions.findOne({
                appointmentId: appointmentIdString,
                customerId,
                status: "pending",
            });

            if (existingTransaction?.stripeSessionId) {
                const existingSession =
                    await stripe.checkout.sessions.retrieve(
                        existingTransaction.stripeSessionId
                    );

                if (
                    existingSession.status === "open" &&
                    existingSession.url &&
                    existingSession.success_url === successUrl &&
                    existingSession.cancel_url === cancelUrl
                ) {
                    return res.status(200).json({
                        success: true,
                        message: "Existing checkout session retrieved",
                        checkoutUrl: existingSession.url,
                        sessionId: existingSession.id,
                    });
                }

                if (existingSession.status === "complete") {
                    return res.status(409).json({
                        success: false,
                        message: "Payment is being processed. Please wait for confirmation.",
                    });
                }

                if (existingSession.status === "open") {
                    await stripe.checkout.sessions.expire(
                        existingSession.id
                    );
                }

                await transactions.updateOne(
                    {
                        _id: existingTransaction._id,
                        status: "pending",
                    },
                    {
                        $set: {
                            status: "expired",
                            updatedAt: new Date(),
                        },
                    }
                );
            }

            const metadata = {
                appointmentId: appointmentIdString,
                customerId,
                serviceId: String(serviceId),
            };

            const session = await stripe.checkout.sessions.create({
                mode: "payment",

                line_items: [
                    {
                        price_data: {
                            currency,
                            product_data: {
                                name: service.serviceName,
                                description: `Appointment on ${appointment.appointmentDate} at ${appointment.timeSlot}`,
                            },
                            unit_amount: amountInMinorUnit,
                        },
                        quantity: 1,
                    },
                ],

                ...(req.authUser.email
                    ? {
                        customer_email: req.authUser.email,
                    }
                    : {}),

                client_reference_id: appointmentIdString,

                metadata,

                payment_intent_data: {
                    metadata,
                },

                success_url: successUrl,

                cancel_url: cancelUrl,
            });

            if (!session.url) {
                return res.status(500).json({
                    success: false,
                    message: "Failed to generate checkout URL",
                });
            }

            const transaction = {
                appointmentId: appointmentIdString,
                customerId,

                customerName: req.authUser.name || "",
                customerEmail: req.authUser.email || "",

                serviceId: String(serviceId),
                serviceName: service.serviceName,

                appointmentDate: appointment.appointmentDate,
                timeSlot: appointment.timeSlot,

                amount,
                currency,

                stripeSessionId: session.id,
                stripePaymentIntentId: null,

                status: "pending",
                paymentStatus: "unpaid",

                createdAt: new Date(),
                updatedAt: new Date(),
                paidAt: null,
            };

            try {
                await transactions.insertOne(transaction);
            } catch (dbError) {
                await stripe.checkout.sessions.expire(session.id)
                    .catch((expireError) => {
                        console.error(
                            "Checkout expiration error:",
                            expireError.message
                        );
                    });

                throw dbError;
            }

            return res.status(201).json({
                success: true,
                message: "Checkout session created successfully",
                checkoutUrl: session.url,
                sessionId: session.id,
            });

        } catch (error) {
            console.error(
                "Create checkout session error:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Failed to create checkout session",
            });
        }
    }
);


app.post("/payments/checkout-verify", verifyCustomer, async (req, res) => {
    try {
        const { sessionId } = req.body || {};

        if (
            typeof sessionId !== "string" ||
            !sessionId.startsWith("cs_") ||
            sessionId.length > 255
        ) {
            return res.status(400).json({
                success: false,
                message: "A valid Stripe session ID is required",
            });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (
            session.mode !== "payment" ||
            session.status !== "complete" ||
            session.payment_status !== "paid"
        ) {
            return res.status(400).json({
                success: false,
                message: "Payment has not been completed",
            });
        }

        const metadata = session.metadata || {};
        const customerId = req.authUser.id;
        const appointmentId = metadata.appointmentId;
        const serviceId = metadata.serviceId;

        if (
            metadata.customerId !== customerId ||
            !ObjectId.isValid(appointmentId) ||
            session.client_reference_id !== appointmentId
        ) {
            return res.status(403).json({
                success: false,
                message: "This payment session does not belong to your account",
            });
        }

        const transaction = await transactions.findOne({
            stripeSessionId: session.id,
            appointmentId,
            customerId,
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                message: "Payment transaction not found",
            });
        }

        if (
            transaction.serviceId !== serviceId ||
            !["pending", "paid"].includes(transaction.status)
        ) {
            return res.status(409).json({
                success: false,
                message: "This transaction is not eligible for verification",
            });
        }

        const appointmentObjectId = new ObjectId(appointmentId);

        const appointment = await appointments.findOne({
            _id: appointmentObjectId,
            customerId,
        });

        if (!appointment) {
            return res.status(404).json({
                success: false,
                message: "Appointment not found",
            });
        }

        if (appointment.serviceId !== transaction.serviceId) {
            return res.status(409).json({
                success: false,
                message: "Appointment and transaction details do not match",
            });
        }

        const expectedAmount = Math.round(
            Number(transaction.amount) * 100
        );

        const expectedCurrency = String(
            transaction.currency || ""
        ).toLowerCase();

        if (
            !Number.isSafeInteger(expectedAmount) ||
            expectedAmount <= 0 ||
            session.amount_total !== expectedAmount ||
            session.currency !== expectedCurrency
        ) {
            return res.status(400).json({
                success: false,
                message: "Stripe payment amount or currency does not match the transaction",
            });
        }

        const paymentIntentId =
            typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id || null;

        const paidAt = transaction.paidAt || new Date();

        if (transaction.status !== "paid") {
            await transactions.updateOne(
                {
                    _id: transaction._id,
                    status: "pending",
                },
                {
                    $set: {
                        status: "paid",
                        paymentStatus: "paid",
                        stripePaymentIntentId: paymentIntentId,
                        stripePaymentStatus: session.payment_status,
                        paidAt,
                        updatedAt: new Date(),
                    },
                }
            );
        }

        await appointments.updateOne(
            {
                _id: appointmentObjectId,
                customerId,
                paymentStatus: { $ne: "paid" },
            },
            {
                $set: {
                    paymentStatus: "paid",
                    stripePaymentIntentId: paymentIntentId,
                    paidAt,
                    updatedAt: new Date(),
                },
            }
        );

        const [updatedTransaction, updatedAppointment] =
            await Promise.all([
                transactions.findOne({
                    _id: transaction._id,
                }),

                appointments.findOne({
                    _id: appointmentObjectId,
                    customerId,
                }),
            ]);

        if (
            updatedTransaction?.status !== "paid" ||
            updatedTransaction?.paymentStatus !== "paid" ||
            updatedAppointment?.paymentStatus !== "paid"
        ) {
            return res.status(500).json({
                success: false,
                message: "Payment was received, but the database update could not be completed. Please retry verification.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Payment verified successfully",

            transaction: {
                id: updatedTransaction._id.toString(),
                appointmentId: updatedTransaction.appointmentId,
                amount: updatedTransaction.amount,
                currency: updatedTransaction.currency,
                status: updatedTransaction.status,
                paymentStatus: updatedTransaction.paymentStatus,
                paidAt: updatedTransaction.paidAt,
            },

            appointment: {
                id: updatedAppointment._id.toString(),
                paymentStatus: updatedAppointment.paymentStatus,
            },
        });

    } catch (error) {
        console.error("Checkout verification error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to verify payment",
        });
    }
});


// transctions related api


app.get("/admin/transactions", verifyAdmin, async (req, res) => {
    try {
        const allTransactions = await transactions
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        const formattedTransactions = await Promise.all(
            allTransactions.map(async (transaction) => {
                const customerId = String(transaction.customerId || "");
                const appointmentId = String(transaction.appointmentId || "");
                const serviceId = String(transaction.serviceId || "");

                const customerFilters = customerId
                    ? [
                        { _id: customerId },
                        { id: customerId },
                    ]
                    : [];

                if (ObjectId.isValid(customerId)) {
                    customerFilters.push({
                        _id: new ObjectId(customerId),
                    });
                }

                const [customer, appointment, service] = await Promise.all([
                    customerFilters.length
                        ? users.findOne(
                            { $or: customerFilters },
                            {
                                projection: {
                                    name: 1,
                                    email: 1,
                                },
                            }
                        )
                        : null,

                    ObjectId.isValid(appointmentId)
                        ? appointments.findOne({
                            _id: new ObjectId(appointmentId),
                        })
                        : null,

                    ObjectId.isValid(serviceId)
                        ? salonbook.findOne({
                            _id: new ObjectId(serviceId),
                        })
                        : null,
                ]);

                return {
                    _id: transaction._id.toString(),

                    customerName:
                        transaction.customerName ||
                        customer?.name ||
                        "Unknown Customer",

                    customerEmail:
                        transaction.customerEmail ||
                        customer?.email ||
                        "",

                    serviceName:
                        transaction.serviceName ||
                        service?.serviceName ||
                        "Unknown Service",

                    appointmentDate:
                        transaction.appointmentDate ||
                        appointment?.appointmentDate ||
                        null,

                    timeSlot:
                        transaction.timeSlot ||
                        appointment?.timeSlot ||
                        "",

                    amount: Number(transaction.amount || 0),

                    currency: String(
                        transaction.currency || "bdt"
                    ).toLowerCase(),

                    stripeSessionId:
                        transaction.stripeSessionId || "",

                    paymentStatus:
                        transaction.paymentStatus ||
                        (transaction.status === "paid"
                            ? "paid"
                            : transaction.status === "failed"
                                ? "failed"
                                : "unpaid"),

                    transactionStatus:
                        transaction.status || "pending",

                    transactionDate:
                        transaction.createdAt ||
                        transaction.payment_date ||
                        transaction.paidAt ||
                        null,
                };
            })
        );

        return res.status(200).json({
            success: true,
            count: formattedTransactions.length,
            transactions: formattedTransactions,
        });

    } catch (error) {
        console.error("Admin transactions fetch error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch transactions",
        });
    }
});



app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});