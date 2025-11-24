require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, collection, updateDoc } = require('firebase/firestore');

const app = express();

// Firebase Configuration (should match your frontend)
const firebaseConfig = {
    apiKey: "AIzaSyB0EJg9zyLwB22PDfFfq9JSZy0J495zYwg",
    authDomain: "sell-app-b0dda.firebaseapp.com",
    projectId: "sell-app-b0dda",
    storageBucket: "sell-app-b0dda.firebasestorage.app",
    messagingSenderId: "558097179965",
    appId: "1:558097179965:web:f85e182bb5664ac3d31154",
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Middleware
app.use(cors()); // Allow requests from your React frontend
app.use(express.json()); // To parse JSON request bodies

// Securely get the Paystack secret key from environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
    console.error("FATAL ERROR: PAYSTACK_SECRET_KEY is not defined in .env file.");
    process.exit(1); // Exit if the secret key is not configured
}

const paystack = axios.create({
    baseURL: 'https://api.paystack.co',
    headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
    },
});

// --- API Endpoints ---

// Endpoint to verify the initial card-saving transaction
app.post('/api/verify-payment', async (req, res) => {
    const { reference, userId } = req.body;

    if (!reference || !userId) {
        return res.status(400).json({ error: 'Reference and userId are required.' });
    }

    try {
        const { data } = await paystack.get(`/transaction/verify/${encodeURIComponent(reference)}`);

        if (data.data.status === 'success') {
            const cardDetails = data.data.authorization;

            // Securely save the authorization details to Firestore for future charges
            const userDocRef = doc(db, 'users', userId);
            await setDoc(userDocRef, {
                payment_details: {
                    authorization_code: cardDetails.authorization_code,
                    last4: cardDetails.last4,
                    exp_month: cardDetails.exp_month,
                    exp_year: cardDetails.exp_year,
                    brand: cardDetails.brand,
                }
            }, { merge: true });

            res.status(200).json({ message: 'Payment verified and card saved.', cardDetails });
        } else {
            res.status(400).json({ error: 'Payment verification failed.' });
        }
    } catch (error) {
        console.error('Paystack verification error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'An error occurred during payment verification.' });
    }
});

// Endpoint to charge a saved card for a purchase
app.post('/api/charge-card', async (req, res) => {
    const { userId, cardTitle, email, amount, authorization_code } = req.body;

    if (!userId || !cardTitle || !email || !amount || !authorization_code) {
        return res.status(400).json({ error: 'Missing required payment details.' });
    }

    try {
        // Charge the saved card using the authorization code
        const { data } = await paystack.post('/transaction/charge_authorization', {
            email,
            amount,
            authorization_code,
            metadata: {
                userId,
                cardId: cardTitle, // Keep metadata consistent if needed elsewhere
            }
        });

        if (data.data.status === 'success') {
            // Payment successful, now update Firestore with the card's new status
            const activePeriodDays = { 'Pinkies': 10, 'Kleepa': 20, 'Two Kleepa': 30 }[cardTitle] || 10;
            const activeUntil = new Date();
            activeUntil.setDate(activeUntil.getDate() + activePeriodDays);

            // Get a reference to the specific card document using its title as the ID.
            const cardStatusRef = doc(db, 'users', userId, 'card_status', cardTitle);
            // --- Get the merchant's Paystack authorization code from environment variables ---
            const MERCHANT_AUTHORIZATION_CODE = process.env.MERCHANT_AUTHORIZATION_CODE;
            if (!MERCHANT_AUTHORIZATION_CODE) {
                console.error("FATAL ERROR: MERCHANT_AUTHORIZATION_CODE is not defined in .env file.");
            }

            // --- Define the transaction parties as you requested ---
            // 1. The receiver of the funds (the app owner/merchant). This is saved as primary_seller.
            const appOwnerDetails = {
                name: "Sell App Merchant",
                authorization_code: MERCHANT_AUTHORIZATION_CODE // Store the authorization code
            };

            // 2. The buyer's details (fetched from their user document). This is saved as secondary_seller.
            const buyerDocRef = doc(db, 'users', userId);
            const buyerDocSnap = await getDoc(buyerDocRef);
            const buyerCardDetails = buyerDocSnap.exists() ? buyerDocSnap.data().payment_details : null;

            // Get the current sales count before updating.
            const cardSnap = await getDoc(cardStatusRef);
            const currentSales = cardSnap.exists() ? cardSnap.data().sales || 0 : 0;

            const cardUpdateData = {
                title: cardTitle, // Store the type of card
                card_status: true,
                activeUntil: activeUntil,
                sales: currentSales, // Keep the existing sales count
                primary_seller: appOwnerDetails,
                secondary_seller: buyerCardDetails
            };

            // Update the card document with the correct status and seller fields
            await setDoc(cardStatusRef, cardUpdateData, { merge: true });

            res.status(200).json({
                message: 'Card purchased successfully!',
                updatedCard: { ...cardUpdateData, id: cardTitle, activeUntil: activeUntil.toISOString() }
            });

        } else {
            res.status(400).json({ error: data.data.gateway_response || 'Payment failed.' });
        }
    } catch (error) {
        console.error('Paystack charge error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: error.response?.data?.message || 'An error occurred while charging the card.' });
    }
});

// Endpoint to list a card for sale
app.post('/api/list-card-for-sale', async (req, res) => {
    const { userId, cardId } = req.body;
    if (!userId || !cardId) {
        return res.status(400).json({ error: 'User ID and Card ID are required.' });
    }
    try {
        const cardRef = doc(db, 'users', userId, 'card_status', cardId);
        await updateDoc(cardRef, { card_onSale: true });
        res.status(200).json({ message: 'Card is now listed for sale.' });
    } catch (error) {
        console.error('Error listing card for sale:', error);
        res.status(500).json({ error: 'Failed to list card for sale.' });
    }
});

// Endpoint to cancel a sale listing
app.post('/api/cancel-sale', async (req, res) => {
    const { userId, cardId } = req.body;
    if (!userId || !cardId) {
        return res.status(400).json({ error: 'User ID and Card ID are required.' });
    }
    try {
        const cardRef = doc(db, 'users', userId, 'card_status', cardId);
        await updateDoc(cardRef, { card_onSale: false });
        res.status(200).json({ message: 'Sale listing has been cancelled.' });
    } catch (error) {
        console.error('Error cancelling sale:', error);
        res.status(500).json({ error: 'Failed to cancel sale.' });
    }
});

// Endpoint for a buyer to finalize a purchase, which updates the seller's card
app.post('/api/finalize-sale', async (req, res) => {
    const { sellerId, cardId } = req.body; // The original owner (seller) and the card ID
    if (!sellerId || !cardId) {
        return res.status(400).json({ error: 'Seller ID and Card ID are required.' });
    }
    try {
        const cardRef = doc(db, 'users', sellerId, 'card_status', cardId);
        const cardSnap = await getDoc(cardRef);

        if (!cardSnap.exists()) {
            return res.status(404).json({ error: 'Card not found.' });
        }

        const currentSales = cardSnap.data().sales || 0;
        await setDoc(cardRef, { card_onSale: false, sales: currentSales + 1 }, { merge: true });
        res.status(200).json({ message: 'Sale finalized successfully.' });
    } catch (error) {
        console.error('Error finalizing sale:', error);
        res.status(500).json({ error: 'Failed to finalize sale.' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
