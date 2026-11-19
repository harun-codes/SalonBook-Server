import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = process.env.PORT || 5000;


app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}));

app.use(express.json());

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

        if (typeof image !== "string" || cleanImage.length > 2048) {
            return res.status(400).json({
                success: false,
                message: "Invalid service image",
            });
        }

        if (cleanImage) {
            try {
                const imageUrl = new URL(cleanImage);

                if (imageUrl.protocol !== "https:") {
                    return res.status(400).json({
                        success: false,
                        message: "Service image must use HTTPS",
                    });
                }
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid service image URL",
                });
            }
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

            if (image) {
                try {
                    const imageUrl = new URL(image);

                    if (imageUrl.protocol !== "https:") {
                        return res.status(400).json({
                            success: false,
                            message: "Service image must use HTTPS",
                        });
                    }
                } catch {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid service image URL",
                    });
                }
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


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});