import m0000 from "./0000_commands_tables.sql";
import m0001 from "./0001_seed_default_commands.sql";
import m0002 from "./0002_seed_stream_commands.sql";
import m0003 from "./0003_vip_can_update_leak.sql";
import m0004 from "./0004_add_browser_command.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
		m0004,
	},
};
