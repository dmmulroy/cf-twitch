import m0000 from "./0000_illegal_maximus.sql";
import m0001 from "./0001_add_stream_live.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
	},
};
