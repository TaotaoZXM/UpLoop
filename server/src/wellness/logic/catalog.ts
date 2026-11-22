import { existsSync, readFileSync } from "node:fs";

export type FoodFlag = "food" | "water" | "caloric" | "alcohol";

export type Food = {  id: string;
  name: string;
  aliases: string[];
  kcal: number;
  p: number;
  c: number;
  f: number;
  flag: FoodFlag;
  cat: string;
  note: string;
  fdcId: string | null;
};

export type Portion = {
  foodId: string;
  unit: string;
  grams: number;
  state: string;
  source: string;
  note: string;
};

type Rule = [unit: string, grams: number, state: string, source: string, note: string];

const RULES: Record<string, Rule[]> = {
  staple: [
    ["碗", 200, "熟", "估算", "家用碗，熟重"],
    ["小碗", 150, "熟", "估算", "较小的碗"],
  ],
  porridge: [["碗", 300, "熟", "估算", "一碗粥"]],
  piece: [["个", 80, "熟", "媒体转述", "一个约 80 克，馒头参考面粉 50 克出馒头 70–80 克"]],
  noodle: [["碗", 250, "熟", "估算", "一碗熟面"]],
  meat: [
    ["掌心", 50, "生", "膳食指南转述", "一份肉约掌心，生重约 50 克"],
    ["块", 100, "熟", "估算", "一块熟肉约 100 克"],
  ],
  egg: [["个", 50, "即食", "估算", "一个中等鸡蛋可食部约 50 克"]],
  fish: [
    ["条", 150, "熟", "估算", "一小条可食部"],
    ["块", 100, "熟", "估算", "一块约 100 克"],
  ],
  soy: [["块", 100, "即食", "估算", "约 100 克"]],
  veg: [["份", 100, "生", "膳食指南转述", "一份蔬菜约 100 克"]],
  fruit: [["个", 150, "即食", "估算", "一个中等大小"]],
  drink: [
    ["杯", 250, "饮品", "估算", "一杯约 250 毫升"],
    ["瓶", 500, "饮品", "估算", "一瓶约 500 毫升"],
  ],
  sweetdrink: [
    ["杯", 250, "饮品", "估算", "一杯约 250 毫升"],
    ["罐", 330, "饮品", "估算", "一罐约 330 毫升"],
  ],
  beer: [
    ["杯", 250, "饮品", "估算", "一杯约 250 毫升"],
    ["罐", 330, "饮品", "估算", "一罐约 330 毫升"],
  ],
  wine: [["杯", 150, "饮品", "估算", "一杯葡萄酒约 150 毫升"]],
  spirit: [
    ["杯", 50, "饮品", "估算", "一小杯约 50 毫升"],
    ["两", 50, "饮品", "估算", "一两约 50 毫升"],
  ],
  dish: [["份", 200, "熟", "估算", "一份家常菜约 200 克"]],
  soup: [["碗", 300, "熟", "估算", "一碗汤约 300 克"]],
  dairy: [["杯", 250, "即食", "估算", "一杯约 250 毫升"]],
  snack: [["份", 30, "即食", "估算", "一小份约 30 克"]],
  nut: [["把", 15, "即食", "估算", "一小把约 15 克"]],
  oil: [["勺", 10, "即食", "膳食指南转述", "一瓷勺油约 10 克"]],
  protein: [["勺", 30, "即食", "估算", "一平勺蛋白粉约 30 克"]],
};

const OVERRIDES: Record<string, Rule[]> = {
  roubao: [["个", 100, "熟", "估算", "一个肉包约 100 克"]],
  dumpling: [
    ["个", 25, "熟", "估算", "一个煮饺约 25 克"],
    ["份", 200, "熟", "估算", "一份约 8 个"],
  ],
  youtiao: [["根", 50, "熟", "估算", "一根油条约 50 克"]],
  bread: [
    ["片", 30, "即食", "估算", "一片吐司约 30 克"],
    ["个", 80, "即食", "估算", "一个小面包"],
  ],
  "whole-bread": [["片", 35, "即食", "估算", "一片全麦约 35 克"]],
  banana: [["根", 120, "即食", "估算", "一根中等香蕉去皮约 120 克"]],
  apple: [["个", 200, "即食", "估算", "一个中等苹果约 200 克"]],
  orange: [["个", 180, "即食", "估算", "一个橙子可食部约 180 克"]],
  pear: [["个", 200, "即食", "估算", "一个梨约 200 克"]],
  grape: [["串", 150, "即食", "估算", "一小串约 150 克"]],
  watermelon: [["块", 300, "即食", "估算", "一块西瓜瓤约 300 克"]],
  strawberry: [["份", 150, "即食", "估算", "一小盒约 150 克"]],
  kiwi: [["个", 100, "即食", "估算", "一个猕猴桃约 100 克"]],
  blueberry: [["把", 80, "即食", "估算", "一小把约 80 克"]],
  mango: [["个", 200, "即食", "估算", "一个芒果肉约 200 克"]],
  peach: [["个", 150, "即食", "估算", "一个桃子约 150 克"]],
  pomelo: [["瓣", 200, "即食", "估算", "几瓣约 200 克"]],
  "milk-tea": [
    ["杯", 500, "饮品", "估算", "中杯奶茶约 500 毫升"],
    ["大杯", 700, "饮品", "估算", "大杯约 700 毫升"],
  ],
  burger: [["个", 200, "即食", "估算", "一个汉堡约 200 克"]],
  pizza: [["片", 100, "即食", "估算", "一小片约 100 克"]],
  tangyuan: [["个", 30, "熟", "估算", "一个汤圆约 30 克"]],
  egg: [["个", 50, "即食", "估算", "一个中等鸡蛋可食部约 50 克"]],
  "egg-white": [["个", 33, "即食", "估算", "一个蛋清约 33 克"]],
  instant: [["桶", 120, "即食", "估算", "面饼约 100–120 克，按干面饼"]],
  cheese: [["片", 20, "即食", "估算", "一片奶酪约 20 克"]],
  yogurt: [["杯", 200, "即食", "估算", "一杯酸奶约 200 克"]],
  "sweet-yogurt": [["杯", 200, "即食", "估算", "一杯风味酸奶约 200 克"]],
};

/**
 * 表 A 份量 + 表 B 中文映射 + USDA 离线子集。
 * 每 100 克数值来自 USDA FoodData Central（CC0）常用条目的四舍五入，或家常菜的表内估算。
 * fdc_id 首版留空，加载器可按 id 回填。混合菜标在 note 里，仍然算查表命中。
 * 字段：id|名称|别名,别名|kcal|蛋白|碳水|脂肪|flag|cat|备注
 */
const RAW = `
rice|米饭|白饭,大米饭|130|2.7|28.2|0.3|food|staple|熟白米饭，USDA 常用值四舍五入
brown-rice|糙米饭|糙米,煮糙米|123|2.7|25.6|1|food|staple|熟糙米饭
purple-rice|紫米饭|紫米,黑米饭|140|3.2|29|0.8|food|staple|熟重，表内估算
glutinous|糯米饭|糯米,江米饭|97|2|21.1|0.2|food|staple|熟糯米
fried-rice|炒饭|扬州炒饭,酱油炒饭|190|5.5|28|6.5|food|staple|含少量油和蛋，表内估算
egg-fried-rice|蛋炒饭|鸡蛋炒饭,蛋饭|180|6.5|26|6|food|staple|表内估算
congee|白粥|大米粥,稀饭|35|0.8|7.2|0.1|food|porridge|稀粥，表内估算
millet-porridge|小米粥|小米稀饭,粟米粥|46|1.4|8.4|0.4|food|porridge|表内估算
oat-porridge|燕麦粥|麦片粥,煮燕麦|71|2.5|12|1.5|food|porridge|熟燕麦
corn-porridge|玉米粥|玉米渣粥,苞米粥|50|1.2|10|0.5|food|porridge|表内估算
mantou|馒头|白馒头,蒸馒头|223|7|47|1.1|food|piece|熟馒头
huajuan|花卷|蒸花卷,葱油花卷|220|7|45|2|food|piece|表内估算
roubao|肉包|猪肉包,鲜肉包|230|8|35|7|food|piece|表内估算
caibao|菜包|素包,青菜包|180|6|36|2|food|piece|表内估算
dumpling|饺子|水饺,猪肉饺子|220|9|28|8|food|piece|煮饺子，表内估算
wonton|馄饨|云吞,小馄饨|160|7|22|5|food|piece|表内估算
shaobing|烧饼|芝麻烧饼,火烧饼|280|8|50|6|food|piece|表内估算
bread|面包|白面包,吐司|265|9|49|3.2|food|piece|白面包
whole-bread|全麦面包|全麦吐司,全麦切片|247|13|41|4.2|food|piece|全麦面包
youtiao|油条|炸油条,油炸鬼|388|6.9|51|17|food|piece|表内估算
noodle|面条|挂面,阳春面|138|4.5|25|2.1|food|noodle|熟面条
ramen|拉面|日式拉面,汤拉面|140|5|22|3|food|noodle|按面体，表内估算
sliced|刀削面|削面,山西刀削面|150|5|26|2|food|noodle|熟面，表内估算
rice-noodle|米粉|米线,干拌米粉|110|2.5|24|0.5|food|noodle|熟米粉
ho-fun|河粉|沙河粉,炒河粉|150|3|28|3|food|noodle|表内估算
chow-mein|炒面|炒面条,酱油炒面|180|6|26|6|food|noodle|表内估算
instant|方便面|泡面,速食面|380|8|55|14|food|noodle|干面饼偏高，泡好后会稀释
liangpi|凉皮|陕西凉皮,面皮凉皮|140|3|26|3|food|noodle|表内估算
chicken-breast|鸡胸肉|鸡胸,水煮鸡胸|165|31|0|3.6|food|meat|熟鸡胸去皮
chicken-thigh|鸡腿|鸡腿肉,去骨鸡腿|184|25|0|9|food|meat|熟，去皮
chicken-wing|鸡翅|烤鸡翅,鸡翅膀|203|19|0|13|food|meat|熟，带皮
beef|牛肉|瘦牛肉,炒牛肉|213|27|0|11|food|meat|熟瘦牛肉
brisket|牛腩|炖牛腩,牛肉腩|250|24|0|17|food|meat|熟，表内估算
steak|牛排|煎牛排,西冷牛排|200|27|0|10|food|meat|熟，少油
pork-loin|猪里脊|里脊肉,瘦猪肉|198|27|0|9|food|meat|熟
belly|五花肉|猪肉五花,炒五花|518|9|0|53|food|meat|熟五花
rib|排骨|猪排骨,炖排骨|280|20|0|22|food|meat|按可食部，表内估算
lamb|羊肉|瘦羊肉,炒羊肉|258|25|0|17|food|meat|熟
duck|鸭肉|烤鸭肉,熟鸭肉|337|19|0|28|food|meat|带皮，表内估算
bacon|培根|煎培根,烟肉|468|37|1.4|35|food|meat|熟培根
ham|火腿|方腿,切片火腿|145|16|2|7|food|meat|表内估算
liver|猪肝|炒猪肝,卤猪肝|165|26|4|4|food|meat|熟，表内估算
egg|鸡蛋|煮鸡蛋,荷包蛋|155|13|1.1|11|food|egg|整枚煮蛋
egg-white|蛋清|鸡蛋白,煮蛋清|52|11|0.7|0.2|food|egg|熟蛋白
salmon|三文鱼|鲑鱼,煎三文鱼|208|20|0|13|food|fish|熟
cod|鳕鱼|烤鳕鱼,银鳕块|105|23|0|0.9|food|fish|熟鳕鱼
carp|鲤鱼|红烧鲤鱼,清蒸鲤鱼|140|18|2|6|food|fish|表内估算
shrimp|虾|虾仁,白灼虾|99|24|0.2|0.3|food|fish|熟虾
crucian|鲫鱼|炖鲫鱼,鲫鱼肉|110|17|0|4|food|fish|鱼肉可食部
hairtail|带鱼|煎带鱼,清蒸带鱼|180|18|2|11|food|fish|表内估算
squid|鱿鱼|炒鱿鱼,鱿鱼须|92|16|3|1.4|food|fish|熟
crab|螃蟹|梭子蟹,蟹肉|97|19|0|1.5|food|fish|蟹肉
tofu|豆腐|北豆腐,嫩豆腐|76|8|1.9|4.8|food|soy|豆腐
tofu-dry|豆干|香干,豆腐干|180|16|8|10|food|soy|表内估算
tofu-skin|腐竹|油豆皮,干腐竹|460|44|15|22|food|soy|干重，泡发后请写克重
edamame|毛豆|煮毛豆,枝豆|122|12|10|5|food|soy|熟
broccoli|西兰花|西蓝花,青花菜|35|2.4|7|0.4|food|veg|熟
spinach|菠菜|熟菠菜,焯菠菜|23|3|3.6|0.3|food|veg|熟
lettuce|生菜|球生菜,罗马生菜|15|1.4|2.9|0.2|food|veg|生
tomato|番茄|西红柿,圣女果|18|0.9|3.9|0.2|food|veg|生
cucumber|黄瓜|青瓜,拍黄瓜|15|0.7|3.6|0.1|food|veg|生
carrot|胡萝卜|红萝卜,熟胡萝卜|35|0.8|8|0.2|food|veg|熟
cabbage|白菜|大白菜,炒白菜|20|1.2|3.5|0.2|food|veg|熟
bokchoy|油菜|小油菜,上海青|20|1.5|3|0.3|food|veg|熟
eggplant|茄子|烧茄子,蒸茄子|35|1|6|1|food|veg|少油，表内估算
pepper|青椒|柿子椒,彩椒|20|0.9|4.6|0.2|food|veg|生
mushroom|蘑菇|口蘑,鲜蘑|22|3.1|3.3|0.3|food|veg|熟
woodear|木耳|黑木耳,泡发木耳|25|1.5|6|0.1|food|veg|泡发后
kelp|海带|海带结,昆布|43|1.7|9|0.6|food|veg|熟
wintermelon|冬瓜|炒冬瓜,冬瓜块|12|0.4|2.6|0.1|food|veg|熟
pumpkin|南瓜|蒸南瓜,南瓜块|26|1|6.5|0.1|food|veg|熟
celery|芹菜|西芹,炒芹菜|16|0.7|3|0.2|food|veg|熟
apple|苹果|红苹果,富士苹果|52|0.3|14|0.2|food|fruit|带皮
banana|香蕉|熟香蕉,香蕉果|89|1.1|23|0.3|food|fruit|去皮
orange|橙子|脐橙,橘子|47|0.9|12|0.1|food|fruit|可食部
pear|梨|雪梨,鸭梨|57|0.4|15|0.1|food|fruit|可食部
grape|葡萄|提子,葡萄粒|69|0.7|18|0.2|food|fruit|可食部
watermelon|西瓜|西瓜瓤,无籽西瓜|30|0.6|8|0.2|food|fruit|瓤
strawberry|草莓|鲜草莓,士多啤梨|32|0.7|8|0.3|food|fruit|可食部
kiwi|猕猴桃|奇异果,绿心猕猴桃|61|1.1|15|0.5|food|fruit|可食部
blueberry|蓝莓|鲜蓝莓,蓝莓果|57|0.7|14|0.3|food|fruit|可食部
mango|芒果|芒果肉,台芒|60|0.8|15|0.4|food|fruit|可食部
peach|桃子|水蜜桃,蜜桃|39|0.9|10|0.3|food|fruit|可食部
pomelo|柚子|沙田柚,蜜柚|38|0.8|10|0.1|food|fruit|可食部
water|白水|白开水,饮用水|0|0|0|0|water|drink|白水
mineral|矿泉水|纯净水,凉白开|0|0|0|0|water|drink|无糖水
tea|茶|绿茶,红茶|1|0|0.2|0|water|drink|清茶不加糖。绿茶提取物不是这一条
amer|美式咖啡|黑咖啡,咖啡|2|0.1|0|0|water|drink|不加糖不加奶
diet-cola|无糖可乐|无糖汽水,零度可乐|1|0|0.2|0|water|drink|代糖汽水按水计
sparkling|无糖苏打|气泡水,苏打水|0|0|0|0|water|drink|无糖
cola|可乐|可口可乐,百事可乐|42|0|10.6|0|caloric|sweetdrink|含糖汽水
sprite|雪碧|柠檬汽水,七喜|40|0|10|0|caloric|sweetdrink|含糖柠檬汽水，表内估算
fenta|芬达|橙味汽水,美年达|45|0|11|0|caloric|sweetdrink|表内估算
oj|橙汁|鲜榨橙汁,柳橙汁|45|0.7|10.4|0.2|caloric|sweetdrink|果汁计入水量和热量
apple-juice|苹果汁|苹果果汁,纯苹果汁|46|0.1|11|0.1|caloric|sweetdrink|含糖饮料
milk-tea|奶茶|珍珠奶茶,全糖奶茶|80|1|14|2|caloric|sweetdrink|全糖奶茶，表内估算
latte|拿铁|咖啡拿铁,热拿铁|48|2.6|4.5|2.2|caloric|sweetdrink|咖啡饮品，计入水量并记热量
mocha|摩卡|摩卡咖啡,巧克力摩卡|70|2.5|10|2.5|caloric|sweetdrink|表内估算
sports|运动饮料|宝矿力,电解质饮料|26|0|6.5|0|caloric|sweetdrink|含糖运动饮料
sweet-soy|甜豆浆|加糖豆浆,甜豆奶|45|2.5|5|1.5|caloric|sweetdrink|加糖才计入水量
sugary|含糖饮料|甜饮料,汽水|42|0|10.6|0|caloric|sweetdrink|种类不明时按可乐近似
beer|啤酒|生啤,熟啤|43|0.5|3.6|0|alcohol|beer|约 5%，不计水量
wine|红酒|红葡萄酒,干红|85|0.1|2.6|0|alcohol|wine|不计水量
white-wine|白葡萄酒|干白,霞多丽|82|0.1|2.6|0|alcohol|wine|葡萄酒，不是白酒
baijiu|白酒|高度白酒,二锅头|298|0|0.5|0|alcohol|spirit|约 52% 酒精度的估算，不计水量
huangjiu|黄酒|绍兴酒,花雕酒|90|1|5|0|alcohol|wine|不计水量
generic-alcohol|酒|果酒,酒精饮料|43|0.5|3.6|0|alcohol|beer|种类不明时按啤酒热量估算，不计水量
milk|牛奶|纯牛奶,全脂牛奶|61|3.2|4.8|3.3|food|dairy|全脂奶，不计入喝水目标
skim|脱脂奶|低脂牛奶,脱脂牛奶|34|3.4|5|0.2|food|dairy|不计入喝水目标
yogurt|酸奶|原味酸奶,无糖酸奶|63|3.5|4.7|3.3|food|dairy|无糖原味
sweet-yogurt|甜酸奶|风味酸奶,果味酸奶|90|3|14|2.5|food|dairy|含糖，仍不按饮料水量计
soy-milk|豆浆|无糖豆浆,鲜豆浆|33|2.9|1.8|1.6|food|dairy|不加糖，不计入喝水目标
cheese|奶酪|芝士,车达奶酪|350|23|3|28|food|dairy|硬质奶酪
tomato-egg|番茄炒蛋|西红柿炒蛋,番茄炒鸡蛋|120|7|6|8|food|dish|家常油量，表内估算
pepper-pork|青椒肉丝|青椒炒肉,辣椒肉丝|160|12|6|10|food|dish|表内估算
yuxiang|鱼香肉丝|鱼香肉片,鱼香猪肉|180|11|12|9|food|dish|表内估算
kungpao|宫保鸡丁|宫爆鸡丁,花生鸡丁|190|14|10|10|food|dish|表内估算
mapo|麻婆豆腐|麻辣豆腐,麻婆豆腐盖饭用菜|130|8|6|9|food|dish|表内估算
braised|红烧肉|红烧五花,东坡肉|350|12|6|32|food|dish|表内估算
stir-veg|炒青菜|清炒时蔬,炒蔬菜|60|2|5|3.5|food|dish|含少量油，表内估算
steamed-fish|清蒸鱼|蒸鱼,清蒸鲈鱼|120|18|1|5|food|dish|表内估算
sweet-sour|糖醋里脊|糖醋瘦肉,糖醋小排|220|14|16|11|food|dish|表内估算
twice|回锅肉|蒜苗回锅肉,回锅肉片|280|12|6|24|food|dish|表内估算
beef-tomato|番茄牛腩|西红柿牛腩,番茄炖牛腩|140|12|6|8|food|dish|表内估算
xiajiao|虾饺|水晶虾饺,广式虾饺|160|8|22|5|food|dish|表内估算
egg-drop|蛋花汤|鸡蛋汤,蛋花汤一碗|30|2|2|1.5|food|soup|表内估算
seaweed-soup|紫菜蛋花汤|紫菜汤,紫菜蛋汤|35|2.5|3|1.5|food|soup|表内估算
tomato-soup|番茄蛋汤|番茄汤,西红柿蛋汤|40|2|5|1.5|food|soup|表内估算
cookie|饼干|曲奇,苏打饼干|450|6|68|16|food|snack|饼干
chocolate|巧克力|黑巧克力,牛奶巧克力|540|6|60|31|food|snack|牛奶巧克力近似
chips|薯片|土豆片,炸薯片|536|7|53|35|food|snack|薯片
fries|薯条|炸薯条,细薯条|312|3.4|41|15|food|snack|炸薯条
burger|汉堡|牛肉汉堡,汉堡包|260|13|27|11|food|snack|每 100 克
pizza|披萨|比萨,芝士披萨|266|11|33|10|food|snack|芝士披萨近似
rice-cake|年糕|炒年糕,桂花年糕|150|3|33|0.5|food|snack|表内估算
tangyuan|汤圆|黑芝麻汤圆,元宵|220|4|40|5|food|snack|熟，表内估算
peanut|花生|熟花生,花生米|567|26|16|49|food|nut|熟花生
almond|杏仁|巴旦木,扁桃仁|579|21|22|50|food|nut|坚果
walnut|核桃|核桃仁,纸皮核桃|654|15|14|65|food|nut|核桃仁
mixed-nut|混合坚果|每日坚果,坚果仁|600|18|20|52|food|nut|表内估算
oil|食用油|植物油,炒菜油|884|0|0|100|food|oil|纯油脂
olive|橄榄油|初榨橄榄油,特级初榨|884|0|0|100|food|oil|纯油脂
whey|蛋白粉|乳清蛋白,乳清粉|400|80|8|5|food|protein|每 100 克粉。询问是否该吃走补剂规则，记摄入走这张表
`;

function parseFoods(raw: string): Food[] {
  const foods: Food[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|");
    if (parts.length !== 10) throw new Error(`catalog row 字段数不对: ${trimmed}`);
    const [id, name, aliasText, kcal, p, c, f, flag, cat, note] = parts;
    foods.push({
      id,
      name,
      aliases: aliasText.split(",").map((s) => s.trim()).filter(Boolean),
      kcal: Number(kcal),
      p: Number(p),
      c: Number(c),
      f: Number(f),
      flag: flag as FoodFlag,
      cat,
      note,
      fdcId: null,
    });
  }
  return foods;
}

export const FOODS: Food[] = parseFoods(RAW);

const aliasOwner = new Map<string, string>();
for (const food of FOODS) {
  for (const alias of [food.name, ...food.aliases]) {
    const prev = aliasOwner.get(alias);
    if (prev && prev !== food.id) throw new Error(`别名冲突「${alias}」: ${prev} / ${food.id}`);
    aliasOwner.set(alias, food.id);
  }
}

export const FOOD_BY_ID = new Map(FOODS.map((food) => [food.id, food]));

export type AliasHit = { food: Food; alias: string };

function buildAliases(): AliasHit[] {
  return FOODS.flatMap((food) => [food.name, ...food.aliases].map((alias) => ({ food, alias }))).sort(
    (a, b) => b.alias.length - a.alias.length,
  );
}

let ALIASES: AliasHit[] = buildAliases();

export function allAliases() {
  return ALIASES;
}
export function buildPortions(foods = FOODS): Portion[] {
  const portions: Portion[] = [];
  for (const food of foods) {
    const rules = OVERRIDES[food.id] || RULES[food.cat];
    if (!rules) throw new Error(`没有份量规则: ${food.id} / ${food.cat}`);
    for (const [unit, grams, state, source, note] of rules) {
      portions.push({ foodId: food.id, unit, grams, state, source, note });
    }
  }
  return portions;
}

export let PORTIONS = buildPortions();

export function loadCatalogExtras(dataDir: string) {
  const dir = `${dataDir}/extra`;
  const foodsFile = `${dir}/foods.json`;
  const portionsFile = `${dir}/portions.json`;
  if (!existsSync(foodsFile) && !existsSync(portionsFile)) return;
  if (existsSync(foodsFile)) {
    const extra = JSON.parse(readFileSync(foodsFile, "utf8")) as Food[];
    for (const food of extra) {
      if (FOOD_BY_ID.has(food.id)) continue;
      FOODS.push(food);
      FOOD_BY_ID.set(food.id, food);
      for (const alias of [food.name, ...food.aliases]) {
        const prev = aliasOwner.get(alias);
        if (prev && prev !== food.id) throw new Error(`扩展表别名冲突「${alias}」`);
        aliasOwner.set(alias, food.id);
      }
    }
  }
  PORTIONS = buildPortions();
  ALIASES = buildAliases();
  if (existsSync(portionsFile)) {
    const extra = JSON.parse(readFileSync(portionsFile, "utf8")) as Portion[];
    PORTIONS.push(...extra);  }
}

export function catalogStats() {
  const mappings = FOODS.reduce((sum, food) => sum + 1 + food.aliases.length, 0);
  return {    foods: FOODS.length,
    portions: PORTIONS.length,
    mappings,
    version: 1,
  };
}
