import { addDays, format } from "date-fns";
import fetch from "node-fetch";

import { sendPushNotification } from "./push-notification.js";
import { scheduleClasses } from "../data/schedule.js";
import config from "../data/config.js";
const {
	user_creds,
	timezone: TIMEZONE,
	coach_priorities: COACH_PRIORITIES,
	alertzyAccountKey,
} = config;

// global vars
let jobs = [];

let user = {
	creds: {
		email: user_creds.email,
		password: user_creds.password,
	},
	id: undefined,
	token: "",
	refreshToken: "",
	membership_id: undefined,
};

export const loginArbox = async () => {
	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/user/login",
			{
				method: "POST",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(user.creds),
			}
		);

		if (response.status !== 200) {
			throw new Error();
		}

		const responseData = await response.json();

		const userMembership = await getArboxMembership(
			responseData.data.token,
			responseData.data.refreshToken
		);
		//save data
		user = {
			...user,
			...responseData.data,
			membership_id: userMembership.id,
		};

		console.log("User logged in succesfully.");
	} catch (e) {
		console.log("Login failed.");
	}
};

export const createEnrollmentJobs = async () => {
	if (!user.token) await loginArbox();

	let schedule = scheduleClasses;

	console.log("Desired schedule: ", schedule);
	const tomorrow_date = format(addDays(new Date(), 1), "yyyy-MM-dd");
	//search if there is a scheduled training enrollment for tomorrow
	for (const classObj of schedule) {
		if (classObj.date === tomorrow_date || classObj.time === "19:00") {
			const boxSchedule = await getArboxScheduleByDate(tomorrow_date);
			let optionalClasses = [];
			for (const boxClass of boxSchedule || []) {
				if (
					boxClass.time === (classObj.start_time || classObj.time) &&
					(!classObj.class_name || boxClass.box_categories.name.trim() === classObj.class_name)
				) {
					optionalClasses.push(boxClass);
				}
			}

			if (optionalClasses.length === 0) {
				console.log(
					"no matching classes found for the time " + (classObj.start_time || classObj.time)
				);
				continue;
			}

			// select a class by preffered coach
			let selected_class = optionalClasses[0];
			if (COACH_PRIORITIES && COACH_PRIORITIES.length > 0) {
				outer: for (const coach of COACH_PRIORITIES) {
					for (const currClass of optionalClasses) {
						if (currClass.coach && coach === currClass.coach.full_name) {
							selected_class = currClass;
							break outer;
						}
					}
				}
			}

			//add enroll_job
			const newJob = {
				extras: null,
				membership_user_id: user.membership_id,
				schedule_id: selected_class.id,
				workoutDetails: {
					class_name: selected_class.box_categories?.name || "Workout",
					start_time: selected_class.time,
					date: tomorrow_date
				},
			};
			addJob(newJob);
		}
	}
};

const getArboxMembership = async (token, refreshtoken) => {
	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/boxes/80/memberships/1",
			{
				method: "GET",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					accesstoken: token,
					refreshtoken: refreshtoken,
				},
			}
		);

		if (response.status !== 200) {
			throw new Error();
		}

		return (await response.json()).data[0];
	} catch (e) {
		console.log("Issue with getting arbox membership.");
	}
};

const getBoxLocationsIdFirst = async (token) => {
	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/boxes/locations",
			{
				method: "GET",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					accesstoken: token,
				},
			}
		);

		if (response.status !== 200) {
			throw new Error();
		}
		const responseData = await response.json();

		return responseData;
	} catch (e) {
		console.log("Issue with getting arbox locations.");
	}
};

const getArboxScheduleByDate = async (date) => {
	const date_normalized = date + "T00:00:00.000Z";

	const locationsData = await getBoxLocationsIdFirst(user.token);
	const locationsBoxId = locationsData?.data?.[0]?.locations_box?.[0]?.id;

	const info = {
		from: date_normalized,
		locations_box_id: locationsBoxId,
		to: date_normalized,
	};

	try {
		const response = await fetch(
			"https://apiappv2.arboxapp.com/api/v2/schedule/betweenDates",
			{
				method: "POST",
				headers: {
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					accesstoken: user.token,
					refreshtoken: user.refreshToken,
				},
				body: JSON.stringify(info),
			}
		);

		if (response.status !== 200) {
			throw new Error();
		}

		return (await response.json()).data;
	} catch (e) {
		console.log("Issue with getting a schedule.");
	}
};

const addJob = (newJobData) => {
	for (const currJob of jobs) {
		if (
			currJob.membership_user_id === newJobData.membership_user_id &&
			currJob.schedule_id === newJobData.schedule_id
		) {
			console.log("Job exist");
			return;
		}
	}
	jobs.push(newJobData);
};

const emptyJobsList = () => {
	jobs = [];
};

export const envokeJobs = async () => {
	for (const currJob of jobs) {
		try {
			const detailsForRegistration = {
				extras: currJob.extras,
				membership_user_id: currJob.membership_user_id,
				schedule_id: currJob.schedule_id,
			};

			const response = await fetch(
				"https://apiappv2.arboxapp.com/api/v2/scheduleUser/insert",
				{
					method: "POST",
					headers: {
						Accept: "application/json, text/plain, */*",
						"Content-Type": "application/json",
						accesstoken: user.token,
						refreshtoken: user.refreshToken,
					},
					body: JSON.stringify(detailsForRegistration),
				}
			);
			const responseData = await response.json();

			if (response.status === 200) {
				console.log("Enrolled succesfully! 🥳");

				if (alertzyAccountKey) {
					await sendPushNotification(
						alertzyAccountKey,
						"[Arbox] Enrolled succesfully",
						`Workout [${currJob.workoutDetails.class_name}] at ${currJob.workoutDetails.start_time} - ${currJob.workoutDetails.date}`
					);
				}
			} else {
				console.log(responseData.error?.messageToUser || "Enrollment failed.");
			}
		} catch (e) {
			console.log("Issue with enrolling to specific class.");
		}
	}
	emptyJobsList();
};

export const scheduler = async () => {
	console.log("Starting immediate enrollment execution...");
	await createEnrollmentJobs();
	await envokeJobs();
};
