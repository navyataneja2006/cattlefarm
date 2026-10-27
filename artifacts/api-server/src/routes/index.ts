import { Router, type IRouter } from "express";
import healthRouter from "./health";
import thingspeakRouter from "./thingspeak";

const router: IRouter = Router();

router.use(healthRouter);
router.use(thingspeakRouter);

export default router;
