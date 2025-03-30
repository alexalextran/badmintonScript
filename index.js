const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const URL =
  "https://prestons.thebadmintonclub.com.au/secure/customer/booking/v1/public/show?readOnly=false&popupMsgDisabled=false&hideTopSiteBar=false";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

// Create screenshots directory if it doesn't exist
const screenshotDir = path.join(__dirname, "screenshots");
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir);
}

// Array of time slots corresponding to the 19 columns
const TIME_SLOTS = [
  "5am",
  "6am",
  "7am",
  "8am",
  "9am",
  "10am",
  "11am",
  "12pm",
  "1pm",
  "2pm",
  "3pm",
  "4pm",
  "5pm",
  "6pm",
  "7pm",
  "8pm",
  "9pm",
  "10pm",
  "11pm",
];

// Function to get the upcoming Fridays to check
function getUpcomingFridays() {
  const today = new Date();
  const currentDay = today.getDay(); // 0 is Sunday, 6 is Saturday
  const currentHour = today.getHours();

  // Calculate days until next Friday (5 is Friday)
  let daysUntilThisFriday = 5 - currentDay;
  if (daysUntilThisFriday < 0) daysUntilThisFriday += 7;

  // If today is Friday and it's past a reasonable booking hour, skip to next Friday
  const isPastBookingHours = currentDay === 5 && currentHour >= 20; // 8 PM
  if (isPastBookingHours) {
    daysUntilThisFriday = 7; // Skip to next Friday
  }

  // Calculate the dates for this Friday and next Friday
  const thisFriday = new Date(today);
  thisFriday.setDate(today.getDate() + daysUntilThisFriday);
  thisFriday.setHours(0, 0, 0, 0);

  const nextFriday = new Date(thisFriday);
  nextFriday.setDate(thisFriday.getDate() + 7);

  const fridaysToCheck = [];

  // If it's not past booking hours or not Friday, add the current Friday
  if (!isPastBookingHours) {
    fridaysToCheck.push(thisFriday);
  }

  // Always add next Friday
  fridaysToCheck.push(nextFriday);

  // If current Friday is past, add the Friday after next week
  if (isPastBookingHours || daysUntilThisFriday === 0) {
    const fridayAfterNext = new Date(nextFriday);
    fridayAfterNext.setDate(nextFriday.getDate() + 7);
    fridaysToCheck.push(fridayAfterNext);
  }

  return fridaysToCheck;
}

// Function to use specific hardcoded dates instead of automatically calculating Fridays
// Format: 'YYYY-MM-DD'
function getHardcodedDates() {
  // Add your specific dates here in ISO format 'YYYY-MM-DD'
  const dateStrings = [
    "2025-04-04", // Example: First Friday in April 2025
    "2025-04-11", // Example: Second Friday in April 2025
    "2025-04-18", // Example: Third Friday in April 2025
  ];

  // Convert string dates to Date objects
  return dateStrings.map((dateStr) => {
    const date = new Date(dateStr);
    date.setHours(0, 0, 0, 0);
    return date;
  });
}

async function checkAvailabilityForDate(page, date) {
  const formattedDate = date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  console.log(`\nChecking availability for: ${formattedDate}`);

  try {
    // Wait for the calendar to be interactive
    await page.waitForSelector("#cal-btn");
    await page.click("#cal-btn");

    // Wait for the datepicker to be visible
    await page.waitForSelector("#ui-datepicker-div", { visible: true });

    // Select the specific date using more precise selector
    await page.evaluate((dateStr) => {
      const targetDate = new Date(dateStr);
      const year = targetDate.getFullYear();
      const month = targetDate.getMonth();
      const day = targetDate.getDate();

      // Use jQuery datepicker to set the date precisely
      $("#datepicker").datepicker("setDate", new Date(year, month, day));

      // Trigger any necessary change events
      if (typeof datePickerDateChanged === "function") {
        datePickerDateChanged();
      }
    }, date.toISOString());

    // Use page.evaluate to create a delay
    await page.evaluate(() => {
      return new Promise((resolve) => setTimeout(resolve, 3000));
    });

    // Wait for the calendar view table to load
    await page.waitForSelector("#calendar_view_table", { timeout: 5000 });

    // Check for available courts
    const courts = await page.evaluate(() => {
      const table = document.querySelector("#calendar_view_table");
      if (!table) return [];

      const rows = Array.from(table.querySelectorAll("tr"));
      return rows.slice(1, -1).map((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll("td"));
        return {
          courtNumber: rowIndex + 1,
          availableSlots: cells.map((cell) =>
            cell.classList.contains("available")
          ),
        };
      });
    });

    // Check 8PM - 10PM (index 15 and 16)
    const availableCourts = courts
      .map((court) => {
        // Check if both 8pm and 9pm slots are available
        if (court.availableSlots[16] && court.availableSlots[17]) {
          return `Court ${court.courtNumber}`;
        }
        return null;
      })
      .filter(Boolean);

    console.log(
      `Courts available between 8PM - 10PM on ${formattedDate}: ${
        availableCourts.join(", ") || "None"
      }`
    );

    return {
      date: formattedDate,
      availableCourts: availableCourts,
    };
  } catch (error) {
    console.error(`Error checking availability for ${formattedDate}:`, error);
    return {
      date: formattedDate,
      availableCourts: [],
      error: error.message,
    };
  }
}

async function sendEmail(results) {
  if (!results.some((result) => result.availableCourts.length > 0)) {
    console.log("No courts available during the specified time for any date.");
    return;
  }

  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL,
      pass: process.env.PASSWORD,
    },
  });

  // Create email body
  let emailBody = "Available Courts (8PM - 10PM):\n\n";

  results.forEach((result) => {
    if (result.availableCourts.length > 0) {
      emailBody += `${result.date}:\n`;
      emailBody += `${result.availableCourts.join(", ")}\n\n`;
    }
  });

  // Add a timestamp to the email
  emailBody += `\n\nLast checked: ${new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
  })}`;

  try {
    let info = await transporter.sendMail({
      from: `"Badminton Alert" <${process.env.EMAIL}>`,
      to: process.env.RECIPIENT_EMAIL || "your-email@example.com",
      subject: `Badminton Courts Available (8PM - 10PM)`,
      text: emailBody,
    });

    console.log("Email sent: ", info.response);
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

async function checkAvailability() {
  // Toggle between automatic Friday detection and hardcoded dates
  const datesToCheck = getUpcomingFridays(); // Dynamic calculation of upcoming Fridays
  //const datesToCheck = getHardcodedDates(); // Use specific hardcoded dates

  console.log(
    "Dates to check:",
    datesToCheck.map((d) => d.toDateString())
  );

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const page = await browser.newPage();

    // Increase timeout and wait for network idle
    await page.setDefaultTimeout(30000);
    await page.goto(URL, { waitUntil: "networkidle2" });

    const results = [];

    // Check availability for each date
    for (const date of datesToCheck) {
      const result = await checkAvailabilityForDate(page, date);
      results.push(result);
    }

    // Send email if any available courts found
    await sendEmail(results);
  } catch (error) {
    console.error("Error during script execution:", error);
  }
  if (browser) {
    await browser.close();
  }
}

checkAvailability();
