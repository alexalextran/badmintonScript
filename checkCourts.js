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

async function getNextFriday() {
  let nextFriday = new Date("2025-04-24");
  console.log(`Hardcoded date for next Friday: ${nextFriday}`);
  return nextFriday;
}

async function takeScreenshot(page, filename) {
  const screenshotPath = path.join(screenshotDir, filename);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });
  console.log(`Screenshot saved: ${screenshotPath}`);
}

async function checkAvailability() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
    });
    const page = await browser.newPage();

    // Increase timeout and wait for network idle
    await page.setDefaultTimeout(30000);
    await page.goto(URL, { waitUntil: "networkidle2" });
    await takeScreenshot(page, "1-initial-page-load.png");

    // Select the next Friday in the date picker
    const nextFriday = await getNextFriday();
    const formattedDate = nextFriday.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    console.log(`Formatted date for next Friday: ${formattedDate}`);

    // Wait for the calendar to be interactive
    await page.waitForSelector("#cal-btn");
    await page.click("#cal-btn");
    console.log("Clicked on calendar button to open the date picker.");

    // Wait for the datepicker to be visible
    await page.waitForSelector("#ui-datepicker-div", { visible: true });
    await takeScreenshot(page, "2-date-picker-opened.png");

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
    }, nextFriday.toISOString());

    // Use page.evaluate to create a delay
    await page.evaluate(() => {
      return new Promise((resolve) => setTimeout(resolve, 3000));
    });
    await takeScreenshot(page, "3-date-selected.png");

    // Wait for the calendar view table to load
    await page.waitForSelector("#calendar_view_table", { timeout: 5000 });
    await takeScreenshot(page, "4-calendar-view-loaded.png");

    // Check for available courts
    const courts = await page.evaluate(() => {
      const table = document.querySelector("#calendar_view_table");
      if (!table) return [];

      const rows = Array.from(table.querySelectorAll("tr"));
      return rows.slice(1).map((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll("td"));
        return {
          courtNumber: rowIndex + 1,
          availableSlots: cells.map((cell) =>
            cell.classList.contains("available")
          ),
        };
      });
    });

    await takeScreenshot(page, "5-court-availability.png");

    // Detailed logging of available slots
    console.log("Detailed Court Availability:");
    courts.forEach((court) => {
      console.log(`Court ${court.courtNumber}:`);

      // Find and log available time slots
      const availableSlotTimes = court.availableSlots.reduce(
        (acc, isAvailable, index) => {
          if (isAvailable) {
            acc.push(TIME_SLOTS[index]);
          }
          return acc;
        },
        []
      );

      if (availableSlotTimes.length > 0) {
        console.log(`  Available slots: ${availableSlotTimes.join(", ")}`);
      } else {
        console.log("  No available slots");
      }
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
      `\nCourts available between 8PM - 10PM: ${
        availableCourts.join(", ") || "None"
      }`
    );

    if (availableCourts.length > 0) {
      await sendEmail(availableCourts, formattedDate);
    } else {
      console.log("No courts available during the specified time.");
    }
  } catch (error) {
    console.error("Error during script execution:", error);

    // Take a screenshot of the error state if possible
    if (browser) {
      const pages = await browser.pages();
      if (pages.length > 0) {
        await takeScreenshot(pages[0], "error-screenshot.png");
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function sendEmail(courts, date) {
  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL,
      pass: PASSWORD,
    },
  });

  // Attach screenshots to the email
  const attachments = fs
    .readdirSync(screenshotDir)
    .filter((file) => file.endsWith(".png"))
    .map((file) => ({
      filename: file,
      path: path.join(screenshotDir, file),
    }));

  let info = await transporter.sendMail({
    from: `"Badminton Alert" <${EMAIL}>`,
    to: "your-email@example.com",
    subject: `Courts Available on ${date} (8PM - 10PM)`,
    text: `Available courts: ${courts.join(", ")}`,
    attachments: attachments,
  });

  console.log("Email sent: ", info.response);
}

checkAvailability();
