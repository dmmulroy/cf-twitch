import m0000 from "./0000_woozy_stone_men.sql";
import m0001 from "./0001_add_user_streaks.sql";
import m0002 from "./0002_add_event_history.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
	},
};
