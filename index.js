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
      name: user.name,
      email: user.email,
      role: user.role,
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



app.get('/', async(req, res) => {
    res.send('Salon Book Server is Running Succesfully')
})



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




app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});