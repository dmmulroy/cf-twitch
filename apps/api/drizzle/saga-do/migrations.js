import m0000 from "./0000_saga_tables.sql";
import m0001 from "./0001_constrain_saga_lifecycle.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
	},
};
