const express = require("express");
const pool = require("./db");
require("dotenv").config();

const app = express();
app.use(express.json());

app.post("/identify", async (req, res) => {
  const { email, phoneNumber } = req.body;

  if (!email && !phoneNumber) {
    return res.status(400).json({ error: "Email or phoneNumber is required" });
  }

  try {
    const existingQuery = `
      SELECT * FROM contacts
      WHERE email = $1 OR phoneNumber = $2
    `;
    const { rows: matchingContacts } = await pool.query(existingQuery, [email, phoneNumber]);

    // If no matching contact — create a new primary
    if (matchingContacts.length === 0) {
      const insertQuery = `
        INSERT INTO contacts (email, phoneNumber, linkPrecedence)
        VALUES ($1, $2, 'primary')
        RETURNING *
      `;
      const { rows } = await pool.query(insertQuery, [email, phoneNumber]);
      const newContact = rows[0];

      return res.status(200).json({
        contact: {
          primaryContactId: newContact.id,
          emails: newContact.email ? [newContact.email] : [],
          phoneNumbers: newContact.phonenumber ? [newContact.phonenumber] : [],
          secondaryContactIds: [],
        },
      });
    }

    // If there are existing contacts
    let allContacts = [...matchingContacts];

    // Find all linked contacts as well
    const primaryIds = matchingContacts
      .map((c) => (c.linkprecedence === "primary" ? c.id : c.linkedid))
      .filter(Boolean);

    const uniquePrimaryIds = [...new Set(primaryIds)];

    // Find the oldest contact among all
    const getAllLinkedQuery = `
      SELECT * FROM contacts
      WHERE id = ANY($1::int[]) OR linkedId = ANY($1::int[])
    `;
    const { rows: linkedContacts } = await pool.query(getAllLinkedQuery, [uniquePrimaryIds]);

    allContacts = [...allContacts, ...linkedContacts];
    allContacts = [...new Set(allContacts.map(c => c.id))].map(
      id => [...matchingContacts, ...linkedContacts].find(c => c.id === id)
    );

    // Determine final primary
    const primaryContact = allContacts.reduce((prev, curr) =>
      new Date(prev.createdat) < new Date(curr.createdat) ? prev : curr
    );

    // Update other primaries to secondary if needed
    for (let contact of allContacts) {
      if (
        contact.id !== primaryContact.id &&
        contact.linkprecedence === "primary"
      ) {
        await pool.query(
          `
          UPDATE contacts
          SET linkPrecedence = 'secondary',
              linkedId = $1,
              updatedAt = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [primaryContact.id, contact.id]
        );
      }
    }

    // Check if we need to create a new secondary contact
    const existingEmails = allContacts.map((c) => c.email).filter(Boolean);
    const existingPhones = allContacts.map((c) => c.phonenumber).filter(Boolean);

    const isNewInfo =
      (email && !existingEmails.includes(email)) ||
      (phoneNumber && !existingPhones.includes(phoneNumber));

    if (isNewInfo) {
      await pool.query(
        `
        INSERT INTO contacts (email, phoneNumber, linkPrecedence, linkedId)
        VALUES ($1, $2, 'secondary', $3)
      `,
        [email, phoneNumber, primaryContact.id]
      );
    }

    // Fetch final state
    const finalQuery = `
      SELECT * FROM contacts
      WHERE id = $1 OR linkedId = $1
    `;
    const { rows: finalContacts } = await pool.query(finalQuery, [primaryContact.id]);

    const emails = [
      ...new Set(finalContacts.map((c) => c.email).filter(Boolean)),
    ];
    const phoneNumbers = [
      ...new Set(finalContacts.map((c) => c.phonenumber).filter(Boolean)),
    ];
    const secondaryIds = finalContacts
      .filter((c) => c.linkprecedence === "secondary")
      .map((c) => c.id);

    return res.status(200).json({
      contact: {
        primaryContactId: primaryContact.id,
        emails,
        phoneNumbers,
        secondaryContactIds: secondaryIds,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));