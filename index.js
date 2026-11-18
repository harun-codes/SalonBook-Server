import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
const app = express();
const port = process.env.PORT || 5000;



app.use(cors());
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
      _id: new ObjectId(id)
    });

    if (!result) {
      return res.status(404).send({ message: 'Service not found' });
    }

    res.status(200).send(result);
  } catch (error) {
    res.status(500).send({ message: 'Failed to fetch service' });
  }
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});