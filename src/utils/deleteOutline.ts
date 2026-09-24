import u from "@/utils";

export default async function deleteOutline(id: number, projectId: number) {
  const targetOutlineData = await u.db("t_outline").where("id", id).select("data").first();
  if (!targetOutlineData) throw new Error("大纲不存在");

  //筛选出改大纲特有的资产
  const allOutlineDataList = await u.db("t_outline").where("projectId", projectId).andWhere("id", "!=", id).select("data");

  //找出目标ID大纲特有的资产名称
  const allOutlineData = allOutlineDataList
    .map((item) => {
      const data = JSON.parse(item?.data || "[]");
      return [...data.characters, ...data.props, ...data.scenes].map((item: any) => item.name);
    })
    .flat();

  const targetOutLineNames = JSON.parse(targetOutlineData?.data || "[]");

  const targetNames = [...targetOutLineNames.characters, ...targetOutLineNames.props, ...targetOutLineNames.scenes].map((item: any) => item.name);

  const diffAssetsNames = targetNames.filter((item) => !allOutlineData.includes(item));

  if (diffAssetsNames.length) {
    await u.db("t_outline").where("id", id).del();

    await u.db("t_assets").where("projectId", projectId).whereIn("name", diffAssetsNames).del();

    await u.db("t_script").where("outlineId", id).del();
  }
}
