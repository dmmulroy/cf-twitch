import m0000 from "./0000_pending_events.sql";
import m0001 from "./0001_dead_letter_queue.sql";
import m0002 from "./0002_delivery_receipts.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
	},
};
