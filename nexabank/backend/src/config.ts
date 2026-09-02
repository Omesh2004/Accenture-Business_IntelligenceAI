import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"] });

export const config = {
    port: process.env.PORT || 5000,
    env: process.env.NODE_ENV || "production",
};
